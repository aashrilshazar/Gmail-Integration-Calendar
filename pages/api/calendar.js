import { getCalendarClient, ACCOUNTS } from "../../lib/google";

export default async function handler(req, res) {
  const { start, end } = req.query;

  // Default to current week
  const now = new Date();
  const weekStart = start || getMonday(now).toISOString();
  const weekEnd = end || getFriday(now, 7).toISOString();

  try {
    const allEvents = await Promise.all(
      ACCOUNTS.map(async (email) => {
        try {
          const cal = getCalendarClient(email);
          const response = await cal.events.list({
            calendarId: "primary",
            timeMin: weekStart,
            timeMax: weekEnd,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 100,
          });
          return (response.data.items || []).map(event => ({
            id: event.id,
            account: email,
            title: event.summary || "(No title)",
            description: event.description || "",
            start: event.start?.dateTime || event.start?.date,
            end: event.end?.dateTime || event.end?.date,
            attendees: (event.attendees || []).map(a => ({
              email: a.email,
              name: a.displayName || a.email,
              status: a.responseStatus,
            })),
            location: event.location || "",
            hangoutLink: event.hangoutLink || "",
            htmlLink: event.htmlLink || "",
          }));
        } catch (err) {
          console.error(`Calendar error for ${email}:`, err.message);
          return [];
        }
      })
    );

    // Merge and dedupe by event ID + start time
    const seen = new Set();
    const merged = allEvents.flat().filter(event => {
      const key = `${event.title}|${event.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by start time
    merged.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json({ events: merged, weekStart, weekEnd });
  } catch (err) {
    console.error("Calendar API error:", err);
    res.status(500).json({ error: err.message });
  }
}

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getFriday(d, addDays = 0) {
  const date = getMonday(d);
  date.setDate(date.getDate() + addDays);
  return date;
}
