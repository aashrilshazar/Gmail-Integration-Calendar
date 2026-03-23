import { getGmailClient, getCalendarClient, ACCOUNTS } from "../lib/google.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { firm, mode } = req.body || {};
  if (!firm) return res.status(400).json({ error: "Provide a firm name" });

  try {
    // 1. Search Calendar first (so we can extract attendee domains for Gmail search)
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
              maxResults: 20,
            });

            if (!searchRes.data.messages) return [];

            const messages = await Promise.all(
              searchRes.data.messages.slice(0, 10).map(async (msg) => {
                const full = await gmail.users.messages.get({
                  userId: "me",
                  id: msg.id,
                  format: "full",
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
                  body: extractBody(full.data.payload).slice(0, 800),
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

    // 4. Filter emails to only those involving the firm or external attendee domains
    const firmLower = firm.toLowerCase();
    const relevantEmails = emails.filter(e => {
      const text = `${e.from} ${e.to} ${e.subject}`.toLowerCase();
      if (text.includes(firmLower)) return true;
      for (const domain of externalDomains) {
        if (text.includes(domain)) return true;
      }
      return false;
    });

    // 5. Generate AI summary or call prep
    let summary = null;
    let status = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        if (mode === "callprep") {
          summary = await generateCallPrep(firm, relevantEmails, calendarEvents);
        } else {
          const raw = await generateSummary(firm, relevantEmails, calendarEvents);
          if (raw) {
            const lines = raw.split("\n");
            const statusIdx = lines.findIndex(l => l.startsWith("STATUS:"));
            if (statusIdx !== -1) {
              status = lines[statusIdx].replace("STATUS:", "").trim();
              summary = lines.filter((_, i) => i !== statusIdx).join("\n").trim();
            } else {
              summary = raw;
            }
          }
        }
      } catch (err) {
        console.error("Claude summary error:", err.message);
      }
    }

    const result = {
      firm,
      status,
      summary,
      mode: mode || "standard",
      emails: emails.slice(0, 40),
      calendarEvents,
      people,
    };
    res.json(result);
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: err.message });
  }
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}

async function generateSummary(firm, emails, calendarEvents) {
  const emailContext = emails.slice(0, 8).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject}\n${e.body || ""}`
  ).join("\n\n");

  const calendarContext = calendarEvents.slice(0, 5).map(e =>
    `[${e.start}] ${e.title} — Attendees: ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Write a relationship summary for "${firm}" that reads as a clear, cohesive narrative from top to bottom. Note: "${firm}" may be a partial name — match liberally.

EMAILS (sorted newest to oldest):
${emailContext || "None."}

CALENDAR EVENTS:
${calendarContext || "None."}

Your response MUST follow this exact format — a STATUS line first, then 3 to 5 bullet points in strict chronological order (oldest first, most recent last). Together the bullets should tell the complete story of Keye's relationship with this firm.

Rules:
- First line MUST be: STATUS: [one concise phrase, e.g. "Active — last contact March 2026" or "Dormant since Q3 2025" or "No prior contact found"]
- After the STATUS line, each bullet starts with "- " (dash space). No other markdown.
- Oldest event first, most recent event last.
- Each bullet should logically follow from the previous, building a continuous narrative arc.
- Each bullet must be 30 words or fewer. Be ruthlessly concise — cut filler, name only the most important people.
- Each bullet MUST begin with the exact date in "Month D, YYYY: " format — a single calendar date, never a range (e.g. "- January 31, 2026: Rohan reached out..."). If multiple emails span several days, use the date of the first one. Never write "January 21–22" or "Feb 10–13" or any range. Never start with "On", "In", or any other word before the date.
- Group related outreach into one bullet rather than listing each email separately.
- The final bullet must reflect the current status: the most recent interaction and any upcoming meetings.
- Never contradict a previous bullet.

If there is truly no relevant context:
STATUS: No prior communications found
- No prior communications found for ${firm}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!data.content?.[0]?.text) {
    console.error("Claude API error (lookup):", JSON.stringify(data));
  }
  return data.content?.[0]?.text || null;
}

async function generateCallPrep(firm, emails, calendarEvents) {
  const emailContext = emails.slice(0, 8).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject}\n${e.body || ""}`
  ).join("\n\n");

  const calendarContext = calendarEvents.slice(0, 5).map(e =>
    `[${e.start}] ${e.title} — Attendees: ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const prompt = `You are a sales operations analyst at Keye preparing a call brief for a meeting with "${firm}". Use only the data provided below. Be concrete — use actual names and dates from the data. If data is missing for a section, say so in one sentence.

EMAILS (sorted newest to oldest):
${emailContext || "None."}

CALENDAR EVENTS:
${calendarContext || "None."}

Write a concise call prep brief with these five sections using markdown ## headers:

## Relationship Status
One sentence: how active is this relationship and when was the last touchpoint.

## Key Contacts
Each person at ${firm} we have interacted with — name, role if known, most recent interaction.

## Last Interaction
Date, what was discussed, and the outcome or next step agreed upon.

## Open Items / Blockers
Any unresolved threads, pending asks, or blockers from prior communications. If none, say so.

## Suggested Talking Points
2–3 concrete talking points for the call based on the history above.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!data.content?.[0]?.text) {
    console.error("Claude API error (callprep):", JSON.stringify(data));
  }
  return data.content?.[0]?.text || null;
}
