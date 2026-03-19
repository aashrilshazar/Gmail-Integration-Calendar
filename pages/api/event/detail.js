import { getGmailClient, ACCOUNTS } from "../../../lib/google";
import { searchMeetings } from "../../../lib/notion";
import { Redis } from "@upstash/redis";

const redis = process.env.KV_REST_API_URL
  ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
  : null;

const CACHE_TTL = 6 * 60 * 60; // 6 hours

export default async function handler(req, res) {
  const { company, eventTitle, eventDate, attendees: attendeesParam } = req.query;

  if (!company && !eventTitle) {
    return res.status(400).json({ error: "Provide company or eventTitle" });
  }

  const searchTerm = company || eventTitle;
  const attendeeEmails = attendeesParam ? attendeesParam.split(",").map(e => e.trim().toLowerCase()) : [];

  // Check cache
  const cacheKey = `detail:${searchTerm}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.status(200).json(cached);
    } catch (err) {
      console.error("Redis read error:", err.message);
    }
  }

  try {
    // 1. Search Gmail across all accounts
    const emailResults = await Promise.all(
      ACCOUNTS.map(async (email) => {
        try {
          const gmail = getGmailClient(email);
          const searchRes = await gmail.users.messages.list({
            userId: "me",
            q: searchTerm,
            maxResults: 15,
          });

          if (!searchRes.data.messages) return [];

          const messages = await Promise.all(
            searchRes.data.messages.slice(0, 10).map(async (msg) => {
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
                id: msg.id,
                account: email,
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
          console.error(`Gmail error for ${email}:`, err.message);
          return [];
        }
      })
    );

    // Dedupe emails by subject + date
    const seen = new Set();
    let emails = emailResults.flat().filter(e => {
      const key = `${e.subject}|${e.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Filter to only emails between event attendees
    if (attendeeEmails.length > 0) {
      emails = emails.filter(e => {
        const fromAddr = (e.from.match(/<(.+?)>/) || [, e.from])[1].toLowerCase();
        const toAddrs = e.to.split(",").map(t => {
          const m = t.match(/<(.+?)>/);
          return (m ? m[1] : t).trim().toLowerCase();
        });
        const allAddrs = [fromAddr, ...toAddrs];
        return allAddrs.some(a => attendeeEmails.includes(a));
      });
    }

    // Sort newest first
    emails.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 2. Search Notion for meeting transcripts
    const meetings = await searchMeetings(searchTerm);

    // 3. Build people list from emails + attendees
    const peopleSet = new Set();
    emails.forEach(e => {
      if (e.from) peopleSet.add(e.from);
      if (e.to) e.to.split(",").forEach(t => peopleSet.add(t.trim()));
    });
    const people = [...peopleSet].slice(0, 20);

    // 4. Generate Claude summary
    let summary = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        summary = await generateSummary(searchTerm, emails, meetings);
      } catch (err) {
        console.error("Claude summary error:", err.message);
      }
    }

    const result = { company: searchTerm, summary, emails: emails.slice(0, 20), meetings, people };

    // Store in cache
    if (redis) {
      try { await redis.set(cacheKey, result, { ex: CACHE_TTL }); }
      catch (err) { console.error("Redis write error:", err.message); }
    }

    res.status(200).json(result);
  } catch (err) {
    console.error("Event detail error:", err);
    res.status(500).json({ error: err.message });
  }
}

async function generateSummary(company, emails, meetings) {
  const emailContext = emails.slice(0, 8).map(e =>
    `[${e.date}] ${e.subject} — ${e.snippet}`
  ).join("\n");

  const meetingContext = meetings.slice(0, 5).map(m =>
    `[${m.date}] ${m.name} — ${m.summary || "No summary"}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Summarize the relationship and deal status with "${company}" based on:

EMAILS:
${emailContext || "No emails found."}

MEETINGS:
${meetingContext || "No meetings found."}

Respond with exactly 3 to 5 bullet points, ordered from the most recent update to the earliest. Each bullet should be one concise sentence. Do not use markdown formatting — just start each line with a dash and a space like "- Update here". Be direct and actionable. Cover: deal status, key contacts, and next steps.`;

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
