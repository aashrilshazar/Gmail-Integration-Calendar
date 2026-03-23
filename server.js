import "dotenv/config";
import express from "express";
import { getGmailClient, getCalendarClient, ACCOUNTS } from "./lib/google.js";

import { Redis } from "@upstash/redis";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const redisUrl   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl ? new Redis({ url: redisUrl, token: redisToken }) : null;

const CACHE_TTL = 6 * 60 * 60; // 6 hours

async function handleLookup(req, res) {
  const { firm } = req.body;
  if (!firm) return res.status(400).json({ error: "Provide a firm name" });

  // Check cache
  const cacheKey = `lookup:${firm}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(cached);
    } catch (err) {
      console.error("Redis read error:", err.message);
    }
  }

  try {
    // 1. Search Calendar first (so we can extract attendee domains for Gmail search)
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const threeMonthsAhead = new Date(now);
    threeMonthsAhead.setMonth(threeMonthsAhead.getMonth() + 3);

    const calendarResults = await Promise.all(
      ACCOUNTS.map(async (email) => {
        try {
          const cal = getCalendarClient(email);
          const response = await cal.events.list({
            calendarId: "primary",
            timeMin: sixMonthsAgo.toISOString(),
            timeMax: threeMonthsAhead.toISOString(),
            q: firm,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 10,
          });
          return (response.data.items || []).map(event => ({
            account: email,
            title: event.summary || "(No title)",
            start: event.start?.dateTime || event.start?.date,
            end: event.end?.dateTime || event.end?.date,
            attendees: (event.attendees || []).map(a => ({
              email: a.email,
              name: a.displayName || a.email,
              status: a.responseStatus,
            })),
          }));
        } catch (err) {
          console.error(`Calendar error for ${email}:`, err.message);
          return [];
        }
      })
    );

    // Dedupe calendar events
    const calSeen = new Set();
    const calendarEvents = calendarResults.flat().filter(e => {
      const key = `${e.title}|${e.start}`;
      if (calSeen.has(key)) return false;
      calSeen.add(key);
      return true;
    }).sort((a, b) => new Date(b.start) - new Date(a.start));

    // 2. Extract non-Keye attendee domains from calendar events
    const keyeDomains = new Set(["keye.co"]);
    const externalDomains = new Set();
    calendarEvents.forEach(e => {
      e.attendees.forEach(a => {
        const domain = a.email.split("@")[1];
        if (domain && !keyeDomains.has(domain)) {
          externalDomains.add(domain);
        }
      });
    });

    // Build Gmail search queries: firm name + from/to each external domain
    const searchQueries = [firm];
    externalDomains.forEach(domain => searchQueries.push(`from:${domain} OR to:${domain}`));

    // 3. Search Gmail using firm name AND attendee domains
    const emailResults = await Promise.all(
      ACCOUNTS.flatMap((account) =>
        searchQueries.map(async (query) => {
          try {
            const gmail = getGmailClient(account);
            const searchRes = await gmail.users.messages.list({
              userId: "me",
              q: query,
              maxResults: 8,
            });

            if (!searchRes.data.messages) return [];

            const messages = await Promise.all(
              searchRes.data.messages.slice(0, 5).map(async (msg) => {
                const full = await gmail.users.messages.get({
                  userId: "me",
                  id: msg.id,
                  format: "metadata",
                  metadataHeaders: ["From", "To", "Subject", "Date"],
                });
                const headers = full.data.payload?.headers || [];
                const getHeader = (name) =>
                  headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
                return {
                  account,
                  from: getHeader("From"),
                  to: getHeader("To"),
                  subject: getHeader("Subject"),
                  date: getHeader("Date"),
                  snippet: full.data.snippet || "",
                };
              })
            );
            return messages;
          } catch (err) {
            console.error(`Gmail error for ${account} (q=${query}):`, err.message);
            return [];
          }
        })
      )
    );

    // Dedupe emails by subject + date
    const seen = new Set();
    const emails = emailResults.flat().filter(e => {
      const key = `${e.subject}|${e.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    // 4. Build people list
    const peopleSet = new Set();
    emails.forEach(e => {
      if (e.from) peopleSet.add(e.from);
      if (e.to) e.to.split(",").forEach(t => peopleSet.add(t.trim()));
    });
    calendarEvents.forEach(e => {
      e.attendees.forEach(a => peopleSet.add(a.name || a.email));
    });
    const people = [...peopleSet].slice(0, 30);

    // Filter emails to only those involving the firm or external attendee domains
    const firmLower = firm.toLowerCase();
    const relevantEmails = emails.filter(e => {
      const text = `${e.from} ${e.to} ${e.subject}`.toLowerCase();
      if (text.includes(firmLower)) return true;
      for (const domain of externalDomains) {
        if (text.includes(domain)) return true;
      }
      return false;
    });

    // 5. Generate AI summary
    let summary = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        summary = await generateSummary(firm, relevantEmails, calendarEvents);
      } catch (err) {
        console.error("Claude summary error:", err.message);
      }
    }

    const result = { firm, summary, emails: emails.slice(0, 20), calendarEvents, people };

    // Cache result
    if (redis) {
      try { await redis.set(cacheKey, result, { ex: CACHE_TTL }); }
      catch (err) { console.error("Redis write error:", err.message); }
    }

    res.json(result);
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: err.message });
  }
}

app.post("/lookup", handleLookup);
app.post("/api/lookup", handleLookup);

const CHAT_TTL = 60 * 60 * 24 * 7; // 7 days

app.get("/api/history", async (req, res) => {
  if (!redis) return res.json(req.query?.id ? { chat: null } : { chats: [] });

  if (req.query?.id) {
    try {
      const raw = await redis.get(`keye:chat:${req.query.id}`);
      const chat = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      return res.json({ chat });
    } catch (err) {
      console.error("History GET chat:", err.message);
      return res.json({ chat: null });
    }
  }

  try {
    const raw = await redis.lrange("keye:recent_chats", 0, 19);
    const chats = raw.map(c => (typeof c === "string" ? JSON.parse(c) : c));
    const seen = new Set();
    res.json({ chats: chats.filter(c => { const k = c.firm?.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }) });
  } catch { res.json({ chats: [] }); }
});

app.post("/api/history", async (req, res) => {
  const { action, firm, context, id, turn } = req.body || {};
  if (!redis) return res.json({ ok: true, id: Date.now().toString() });

  if (action === "create") {
    if (!firm) return res.status(400).json({ error: "Provide firm" });
    const newId = Date.now().toString();
    const trimmedContext = context
      ? { ...context, emails: (context.emails || []).slice(0, 15) }
      : null;
    const chatData = { id: newId, firm, ts: Date.now(), context: trimmedContext, turns: [] };
    try {
      await redis.set(`keye:chat:${newId}`, JSON.stringify(chatData), { ex: CHAT_TTL });
      await redis.lpush("keye:recent_chats", JSON.stringify({ id: newId, firm, ts: Date.now() }));
      await redis.ltrim("keye:recent_chats", 0, 19);
      return res.json({ ok: true, id: newId });
    } catch (err) {
      console.error("History create:", err.message);
      return res.json({ ok: true, id: newId });
    }
  }

  if (action === "append") {
    if (!id || !turn) return res.status(400).json({ error: "Provide id and turn" });
    try {
      const raw = await redis.get(`keye:chat:${id}`);
      const chat = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      if (!chat) return res.json({ ok: true });
      chat.turns = [...(chat.turns || []), turn];
      await redis.set(`keye:chat:${id}`, JSON.stringify(chat), { ex: CHAT_TTL });
      return res.json({ ok: true });
    } catch (err) {
      console.error("History append:", err.message);
      return res.json({ ok: true });
    }
  }

  return res.status(400).json({ error: "Invalid action" });
});

app.post("/api/search", async (req, res) => {
  const { query, firm, summary, people } = req.body || {};
  if (!query) return res.status(400).json({ error: "Provide a query" });

  const knownContacts = (people || []).slice(0, 40).join(", ");
  const contextBlock = [firm ? `Firm: ${firm}` : null, summary ? `Relationship summary: ${summary}` : null, knownContacts ? `Known contacts: ${knownContacts}` : null].filter(Boolean).join("\n");
  const system = `You are a web research assistant for Keye. Look up public info — titles, roles, locations, prior experience — using web search.\n\n${contextBlock ? `CONTEXT (use to search accurately, do not repeat in answer):\n${contextBlock}\n\n` : ""}Search the firm's team page, LinkedIn, and news. Be concise and cite sources.`;
  const messages = [{ role: "user", content: query }];

  try {
    for (let i = 0; i < 6; i++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system,
          messages,
        }),
      });
      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      const textBlock = data.content?.find(b => b.type === "text");
      if (data.stop_reason === "end_turn") return res.json({ answer: textBlock?.text || "No results found." });
      if (data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content });
        const toolUses = data.content.filter(b => b.type === "tool_use");
        if (!toolUses.length) return res.json({ answer: textBlock?.text || "No results found." });
        messages.push({ role: "user", content: toolUses.map(b => ({ type: "tool_result", tool_use_id: b.id, content: b.result ?? "" })) });
      } else {
        return res.json({ answer: textBlock?.text || "No results found." });
      }
    }
    res.json({ answer: "Search reached iteration limit." });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, context } = req.body || {};
  if (!messages || !context) return res.status(400).json({ error: "Provide messages and context" });

  const emailContext = (context.emails || []).slice(0, 15).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject} — ${e.snippet}`
  ).join("\n");

  const calendarContext = (context.calendarEvents || []).map(e =>
    `[${e.start}] ${e.title} — ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const system = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Answer questions about Keye's relationship with "${context.firm}" using only the data below. Be direct and specific — name names and dates. If something cannot be determined from the context, say so clearly. Do not speculate.

EMAIL HISTORY:
${emailContext || "None."}

MEETING HISTORY:
${calendarContext || "None."}

AI SUMMARY:
${context.summary || "None."}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system,
        messages,
      }),
    });
    const data = await response.json();
    res.json({ answer: data.content?.[0]?.text || "Could not generate a response." });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function generateSummary(firm, emails, calendarEvents) {
  const emailContext = emails.slice(0, 8).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject} — ${e.snippet}`
  ).join("\n");

  const calendarContext = calendarEvents.slice(0, 5).map(e =>
    `[${e.start}] ${e.title} — Attendees: ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Summarize the relationship and deal status with "${firm}" based on the context below. Note: "${firm}" may be a partial name — match liberally.

EMAILS (sorted newest to oldest):
${emailContext || "None."}

CALENDAR EVENTS:
${calendarContext || "None."}

Respond with exactly 3 to 5 bullet points. Start each line with "- " (dash space). Do not use markdown formatting. Each bullet must be a single factual statement.

Bullet point order:
1. First bullet: the latest update or action item.
2. Second bullet: how the most recent calendar meeting was scheduled — who from Keye reached out to who at the firm, on what date, and the context/subject of that outreach (e.g. "Dani Kobrick reached out to Pieter Cilliers as part of the INSEAD Alumni outreach on Feb 25, 2026"). Look at the earliest email thread that led to this meeting being booked.
3. Remaining bullets: other key factual updates in reverse chronological order.

If there is truly no relevant context, respond with a single bullet: "- No prior communications found for ${firm}."`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keye Lookup API running on port ${PORT}`);
  console.log(`POST /lookup  { "firm": "Company Name" }`);
});
