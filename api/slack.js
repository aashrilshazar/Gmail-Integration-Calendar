import { getGmailClient, getCalendarClient, ACCOUNTS } from "../lib/google.js";
import { waitUntil } from "@vercel/functions";
import Redis from "ioredis";

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
  : null;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { command, text, channel_id, response_url } = req.body || {};
  const input = (text || "").trim();

  console.log(`Slack command received: "${command}" | text: "${input}" | channel: ${channel_id}`);

  if (command === "/ask" || command === "/asking") {
    if (!input) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Usage: `/ask who responded?`",
      });
    }
    waitUntil(doAsk(input, channel_id, response_url));
    return res.status(200).json({
      response_type: "in_channel",
      text: `Thinking about: _${input}_...`,
    });
  }

  // /findme path
  if (!input) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Usage: `/findme Insight Partners`",
    });
  }

  waitUntil(doLookup(input, response_url, channel_id));
  return res.status(200).json({
    response_type: "in_channel",
    text: `Looking up *${input}*...`,
  });
}

async function doLookup(firm, responseUrl, channel_id) {
  try {
    const result = await lookup(firm);

    if (redis && channel_id) {
      try {
        await redis.set(
          `findme:${channel_id}`,
          JSON.stringify({ firm, emails: result.emails, calendarEvents: result.calendarEvents }),
          "EX", 4 * 60 * 60
        );
      } catch (err) {
        console.error("Redis write error:", err.message);
      }
    }

    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        text: formatSlackMessage(firm, result),
      }),
    });
  } catch (err) {
    console.error("Slack lookup error:", err);
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: `Error looking up ${firm}: ${err.message}`,
        }),
      });
    }
  }
}

function formatSlackMessage(firm, { summary, calendarEvents }) {
  let msg = `*${firm}*\n\n`;

  if (summary) {
    msg += summary + "\n";
  } else {
    msg += "_No summary available._\n";
  }

  if (calendarEvents && calendarEvents.length > 0) {
    msg += "\n*Upcoming Meetings:*\n";
    calendarEvents.slice(0, 5).forEach(e => {
      const date = new Date(e.start).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      });
      const attendees = e.attendees.map(a => a.name || a.email).join(", ");
      msg += `- ${e.title} | ${date} | ${attendees}\n`;
    });
  }

  return msg;
}

async function lookup(firm) {
  // 1. Search Calendar first
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

  const calSeen = new Set();
  const calendarEvents = calendarResults.flat().filter(e => {
    const key = `${e.title}|${e.start}`;
    if (calSeen.has(key)) return false;
    calSeen.add(key);
    return true;
  }).sort((a, b) => new Date(b.start) - new Date(a.start));

  // 2. Extract non-Keye attendee domains
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

  const searchQueries = [firm];
  externalDomains.forEach(domain => searchQueries.push(`from:${domain} OR to:${domain}`));

  // 3. Search Gmail
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

  const seen = new Set();
  const emails = emailResults.flat().filter(e => {
    const key = `${e.subject}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  // 4. Filter to relevant emails
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
    summary = await generateSummary(firm, relevantEmails, calendarEvents);
  }

  return { summary, calendarEvents, emails: relevantEmails };
}

async function doAsk(question, channel_id, responseUrl) {
  try {
    if (!redis) throw new Error("Redis not configured — set KV_REST_API_URL and KV_REST_API_TOKEN");
    const raw = await redis.get(`findme:${channel_id}`);
    const context = raw ? JSON.parse(raw) : null;
    if (!context) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: "No recent `/findme` lookup found in this channel. Run `/findme [firm]` first.",
        }),
      });
      return;
    }
    const answer = await answerQuestion(question, context);
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: answer }),
    });
  } catch (err) {
    console.error("Ask error:", err);
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", text: `Error: ${err.message}` }),
      });
    }
  }
}

async function answerQuestion(question, { firm, emails, calendarEvents }) {
  const emailContext = (emails || []).slice(0, 8).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject} — ${e.snippet}`
  ).join("\n");

  const calendarContext = (calendarEvents || []).slice(0, 5).map(e =>
    `[${e.start}] ${e.title} — Attendees: ${e.attendees.map(a => `${a.name || a.email} (${a.status})`).join(", ")}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye. Answer the following question about "${firm}" using only the data below. Be direct and specific — name names and dates. If the answer cannot be determined from the context, say so clearly. Do not speculate.

EMAILS (newest first):
${emailContext || "None."}

CALENDAR EVENTS:
${calendarContext || "None."}

QUESTION: ${question}

Answer in 1–3 sentences.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  return data.content?.[0]?.text || "Could not generate an answer.";
}

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
