import "dotenv/config";
import express from "express";
import { getGmailClient, getCalendarClient, ACCOUNTS } from "./lib/google.js";

import { Redis } from "@upstash/redis";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const redis = process.env.KV_REST_API_URL
  ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
  : null;

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
