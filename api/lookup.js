import { getGmailClient, getCalendarClient, ACCOUNTS } from "../lib/google.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { firm } = req.body || {};
  if (!firm) return res.status(400).json({ error: "Provide a firm name" });

  try {
    // 1. Search Gmail across all accounts
    const emailResults = await Promise.all(
      ACCOUNTS.map(async (email) => {
        try {
          const gmail = getGmailClient(email);
          const searchRes = await gmail.users.messages.list({
            userId: "me",
            q: firm,
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
    const emails = emailResults.flat().filter(e => {
      const key = `${e.subject}|${e.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    // 2. Search Calendar across all accounts
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

    // 3. Build people list
    const peopleSet = new Set();
    emails.forEach(e => {
      if (e.from) peopleSet.add(e.from);
      if (e.to) e.to.split(",").forEach(t => peopleSet.add(t.trim()));
    });
    calendarEvents.forEach(e => {
      e.attendees.forEach(a => peopleSet.add(a.name || a.email));
    });
    const people = [...peopleSet].slice(0, 30);

    // 4. Generate AI summary
    let summary = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        summary = await generateSummary(firm, emails, calendarEvents);
      } catch (err) {
        console.error("Claude summary error:", err.message);
      }
    }

    const result = { firm, summary, emails: emails.slice(0, 20), calendarEvents, people };
    res.json(result);
  } catch (err) {
    console.error("Lookup error:", err);
    res.status(500).json({ error: err.message });
  }
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
2. Second bullet: when and who the FIRST (earliest/oldest) correspondence was with. Include names and @keye.co emails involved.
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
