import { getGmailClient, getCalendarClient, ACCOUNTS } from "../lib/google.js";
import { waitUntil } from "@vercel/functions";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // Slack sends form-urlencoded: text = firm name, response_url = where to post result
  const firm = (req.body?.text || "").trim();
  const responseUrl = req.body?.response_url;

  if (!firm) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Usage: `/findme Insight Partners`",
    });
  }

  // Keep the function alive after responding so the lookup can complete
  waitUntil(doLookup(firm, responseUrl));

  // ACK immediately so Slack doesn't timeout
  return res.status(200).json({
    response_type: "in_channel",
    text: `Looking up *${firm}*...`,
  });
}

async function doLookup(firm, responseUrl) {
  try {
    const result = await lookup(firm);
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

  msg += "*Email History*\n";
  if (summary) {
    msg += summary + "\n";
  } else {
    msg += "_No summary available._\n";
  }

  if (calendarEvents && calendarEvents.length > 0) {
    msg += "\n*Meeting History*\n";
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
  const calendarResults = await Promise.all(
    ACCOUNTS.map(async (email) => {
      try {
        const cal = getCalendarClient(email);
        const response = await cal.events.list({
          calendarId: "primary",
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

  return { summary, calendarEvents };
}

async function generateSummary(firm, emails, calendarEvents) {
  const emailContext = emails.slice(0, 8).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject} — ${e.snippet}`
  ).join("\n");

  const calendarContext = calendarEvents.slice(0, 5).map(e =>
    `[${e.start}] ${e.title} — Attendees: ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Write a relationship summary for "${firm}" that reads as a clear, cohesive narrative from top to bottom. Note: "${firm}" may be a partial name — match liberally.

EMAILS (sorted newest to oldest):
${emailContext || "None."}

CALENDAR EVENTS:
${calendarContext || "None."}

Write 3 to 5 bullet points in strict chronological order — oldest first, most recent last. Together they should tell the complete story of Keye's relationship with this firm: how contact was first made, how it developed, and where things stand today.

Rules:
- Start each line with "- " (dash space). No other markdown.
- Oldest event first, most recent event last.
- Each bullet should logically follow from the previous, building a continuous narrative arc.
- Each bullet must be 30 words or fewer. Be ruthlessly concise — cut filler, name only the most important people, omit exhaustive lists.
- Always use exact dates in "Month D, YYYY" format (e.g. "January 31, 2026"). Never use vague references like "January 2026", "Late January", or "early February".
- Group related outreach into one bullet rather than listing each email separately.
- The final bullet must reflect the current status: the most recent interaction and any upcoming meetings.
- Never contradict a previous bullet. If a meeting predates the email outreach, acknowledge that clearly.

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
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || null;
}
