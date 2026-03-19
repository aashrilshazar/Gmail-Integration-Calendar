import { useState, useEffect, useRef } from "react";
import Head from "next/head";

const ACCOUNTS = [
  "dani@keye.co",
  "r.parikh@keye.co",
  "rparikh@keye.co",
  "rohan@keye.co",
];

const ACCOUNT_COLORS = {
  "dani@keye.co": 0,
  "r.parikh@keye.co": 1,
  "rparikh@keye.co": 2,
  "rohan@keye.co": 3,
};

const HOURS = Array.from({ length: 24 }, (_, i) => i); // 12am - 11pm
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatMonthYear(monday) {
  const sunday = addDays(monday, 6);
  if (monday.getMonth() === sunday.getMonth()) {
    return monday.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return `${monday.toLocaleDateString("en-US", { month: "short" })} – ${sunday.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
}

// Extract a "company name" guess from an event title
function guessCompany(title) {
  // Remove common prefixes/suffixes
  let clean = title
    .replace(/^(meeting|call|sync|demo|intro|check-in|standup|1:1)\s*(with|:|-|–)?\s*/i, "")
    .replace(/\s*(meeting|call|sync|demo|intro|check-in)$/i, "")
    .trim();
  return clean || title;
}

export default function Home() {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [allEvents, setAllEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailCache, setDetailCache] = useState({});
  const [fetchedWeeks, setFetchedWeeks] = useState(new Set());
  const fetchedDetails = useRef(new Set());

  // Pre-fetch calendar events: 1 week back, 3 weeks forward
  useEffect(() => {
    const thisMonday = getMonday(new Date());
    const rangeStart = addDays(thisMonday, -7);
    const rangeEnd = addDays(thisMonday, 28);
    fetch(`/api/calendar?start=${rangeStart.toISOString()}&end=${rangeEnd.toISOString()}`)
      .then(res => res.json())
      .then(data => {
        setAllEvents(data.events || []);
        const weeks = new Set();
        for (let i = -1; i <= 3; i++) weeks.add(addDays(thisMonday, i * 7).toISOString());
        setFetchedWeeks(weeks);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const weekFetched = fetchedWeeks.has(weekStart.toISOString());
  const [weekLoading, setWeekLoading] = useState(false);

  const loadWeekEvents = async () => {
    setWeekLoading(true);
    const start = weekStart.toISOString();
    const end = addDays(weekStart, 7).toISOString();
    try {
      const res = await fetch(`/api/calendar?start=${start}&end=${end}`);
      const data = await res.json();
      setAllEvents(prev => [...prev, ...(data.events || [])]);
      setFetchedWeeks(prev => new Set([...prev, start]));
    } catch (err) {
      console.error("Failed to load week:", err);
    }
    setWeekLoading(false);
  };

  // Pre-fetch all event details in background (3 concurrent)
  useEffect(() => {
    if (allEvents.length === 0) return;
    const queue = [];
    const seen = new Set();
    allEvents.forEach(event => {
      const company = guessCompany(event.title);
      const key = `${company}|${event.title}`;
      if (!seen.has(key) && !fetchedDetails.current.has(key)) {
        seen.add(key);
        const emails = (event.attendees || []).map(a => a.email).join(",");
        queue.push({ key, company, title: event.title, emails });
      }
    });
    let idx = 0;
    async function fetchNext() {
      while (idx < queue.length) {
        const { key, company, title, emails } = queue[idx++];
        fetchedDetails.current.add(key);
        try {
          const res = await fetch(`/api/event/detail?company=${encodeURIComponent(company)}&eventTitle=${encodeURIComponent(title)}&attendees=${encodeURIComponent(emails)}`);
          const data = await res.json();
          setDetailCache(prev => ({ ...prev, [key]: data }));
        } catch {}
      }
    }
    fetchNext(); fetchNext(); fetchNext(); // 3 concurrent workers
  }, [allEvents]);

  // Filter allEvents to current week for display
  const events = allEvents.filter(e => {
    const d = new Date(e.start);
    return d >= weekStart && d < addDays(weekStart, 7);
  });

  const openDetail = async (event) => {
    setSelectedEvent(event);
    const company = guessCompany(event.title);
    const key = `${company}|${event.title}`;
    if (detailCache[key]) {
      setDetail(detailCache[key]);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    const attendees = (event.attendees || []).map(a => a.email).join(",");
    try {
      const res = await fetch(`/api/event/detail?company=${encodeURIComponent(company)}&eventTitle=${encodeURIComponent(event.title)}&attendees=${encodeURIComponent(attendees)}`);
      const data = await res.json();
      setDetail(data);
      setDetailCache(prev => ({ ...prev, [key]: data }));
    } catch (err) {
      console.error("Failed to fetch detail:", err);
    }
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setSelectedEvent(null);
    setDetail(null);
  };

  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));
  const goToday = () => setWeekStart(getMonday(new Date()));

  // Build days array for the week
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();
  const todayStr = today.toDateString();

  // Current time indicator
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const nowTop = nowHour * 60;

  // Group events by day
  function eventsForDay(dayDate) {
    const dayStr = dayDate.toDateString();
    return events.filter(e => {
      const eDate = new Date(e.start);
      return eDate.toDateString() === dayStr;
    });
  }

  // Layout overlapping events into columns, expanding to fill free space
  function layoutEvents(dayEvents) {
    if (dayEvents.length === 0) return [];
    const items = dayEvents.map(e => {
      const s = new Date(e.start);
      const en = new Date(e.end);
      return { event: e, startH: s.getHours() + s.getMinutes() / 60, endH: en.getHours() + en.getMinutes() / 60 };
    }).sort((a, b) => a.startH - b.startH || a.endH - b.endH);

    // Assign each event to a column
    const columns = [];
    const itemCol = new Map();
    for (const item of items) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c].at(-1).endH <= item.startH) {
          columns[c].push(item);
          itemCol.set(item, c);
          placed = true;
          break;
        }
      }
      if (!placed) {
        itemCol.set(item, columns.length);
        columns.push([item]);
      }
    }

    const totalCols = columns.length;
    return items.map(item => {
      const col = itemCol.get(item);
      // Expand right into free adjacent columns
      let span = col + 1;
      for (let c = col + 1; c < totalCols; c++) {
        const conflict = columns[c].some(o => o.startH < item.endH && o.endH > item.startH);
        if (conflict) break;
        span = c + 1;
      }
      const top = item.startH * 60;
      const height = Math.max((item.endH - item.startH) * 60, 20);
      const left = `calc(${(col / totalCols) * 100}% + 1px)`;
      const width = `calc(${((span - col) / totalCols) * 100}% - 2px)`;
      return { event: item.event, style: { top: `${top}px`, height: `${height}px`, width, left } };
    });
  }

  return (
    <>
      <Head>
        <title>Keyesight — Sales Calendar</title>
      </Head>

      {/* HEADER */}
      <div className="header">
        <div className="header-left">
          <h1>Keyesight</h1>
          <button className="today-btn" onClick={goToday}>Today</button>
          <button className="nav-arrow" onClick={prevWeek}>&#8249;</button>
          <button className="nav-arrow" onClick={nextWeek}>&#8250;</button>
          <span className="month-label">{formatMonthYear(weekStart)}</span>
        </div>
        <div className="header-right">
          <div className="legend">
            {ACCOUNTS.map((acc, i) => (
              <div key={acc} className="legend-item">
                <div className="legend-dot" style={{ background: `var(--accent-${i + 1})` }} />
                {acc.split("@")[0]}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* LOAD EVENTS BUTTON */}
      {!loading && !weekFetched && (
        <div className="load-bar">
          <button className="load-btn" onClick={loadWeekEvents} disabled={weekLoading}>
            {weekLoading ? "Loading…" : "Load Events"}
          </button>
        </div>
      )}

      {/* CALENDAR */}
      <div className="calendar-container">
        <div className="time-column">
          <div style={{ height: 60 }} />
          {HOURS.map(h => (
            <div key={h} className="time-label">
              {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
            </div>
          ))}
        </div>
        <div className="days-grid">
          {days.map((day, di) => (
            <div key={di} className="day-column">
              <div className={`day-header${day.toDateString() === todayStr ? " today" : ""}`}>
                <div className="day-name">{DAYS[day.getDay()]}</div>
                <div className="day-num">{day.getDate()}</div>
              </div>
              <div className="hour-slots">
                {HOURS.map(h => (
                  <div key={h} className="hour-line" />
                ))}
                {day.toDateString() === todayStr && (
                  <div className="now-line" style={{ top: `${nowTop}px` }} />
                )}
                {!loading && layoutEvents(eventsForDay(day)).map(({ event, style }, ei) => (
                  <div
                    key={`${event.id}-${ei}`}
                    className={`event-tile account-${ACCOUNT_COLORS[event.account] ?? 0}`}
                    style={style}
                    onClick={() => openDetail(event)}
                  >
                    <div className="event-time">{formatTime(event.start)}</div>
                    <div className="event-title">{event.title}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loading && (
        <div className="loading" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}>
          <div className="loading-spinner" /> Loading calendar…
        </div>
      )}

      {/* DETAIL PANEL */}
      {selectedEvent && (
        <>
          <div className="detail-overlay" onClick={closeDetail} />
          <div className="detail-panel">
            <div className="detail-header">
              <div>
                <h2>{selectedEvent.title}</h2>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  {selectedEvent.account}
                </div>
              </div>
              <button className="close-btn" onClick={closeDetail}>✕</button>
            </div>
            <div className="detail-meta">
              <div>📅 {formatDate(selectedEvent.start)} · {formatTime(selectedEvent.start)} – {formatTime(selectedEvent.end)}</div>
              {selectedEvent.location && <div>📍 {selectedEvent.location}</div>}
              {selectedEvent.hangoutLink && (
                <div>🔗 <a href={selectedEvent.hangoutLink} target="_blank" rel="noreferrer" style={{ color: "var(--accent-1)" }}>Join Google Meet</a></div>
              )}
            </div>

            {detailLoading ? (
              <div className="loading"><div className="loading-spinner" /> Pulling deal context…</div>
            ) : detail ? (
              <>
                {/* Claude Summary */}
                {detail.summary && (
                  <div className="detail-section">
                    <h3>AI Summary</h3>
                    <ul className="summary-list">
                      {detail.summary.split("\n").filter(l => l.trim().replace(/^-\s*/, "")).map((line, i) => (
                        <li key={i}>{line.trim().replace(/^-\s*/, "")}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Attendees from the event itself */}
                {selectedEvent.attendees?.length > 0 && (
                  <div className="detail-section">
                    <h3>Attendees</h3>
                    <div className="people-list">
                      {selectedEvent.attendees.map((a, i) => (
                        <span key={i} className="person-tag">
                          {a.name || a.email}
                          {a.status === "accepted" ? " ✓" : a.status === "declined" ? " ✗" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Email Threads */}
                {detail.emails?.length > 0 && (
                  <div className="detail-section">
                    <h3>Email Threads ({detail.emails.length})</h3>
                    {detail.emails.map((email, i) => (
                      <div key={i} className="email-item">
                        <div className="email-subject">{email.subject}</div>
                        <div className="email-meta">{email.from} · {email.date}</div>
                        {email.snippet && <div className="email-snippet">{email.snippet}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Notion Meetings */}
                {detail.meetings?.length > 0 && (
                  <div className="detail-section">
                    <h3>Meeting Transcripts ({detail.meetings.length})</h3>
                    {detail.meetings.map((m, i) => (
                      <div key={i} className="meeting-item">
                        <div className="meeting-name">{m.name}</div>
                        <div className="meeting-date">{m.date}</div>
                        {m.summary && <div className="meeting-summary">{m.summary}</div>}
                        {m.tasks && (
                          <div className="meeting-summary" style={{ color: "var(--accent-3)" }}>
                            Tasks: {m.tasks}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* People */}
                {detail.people?.length > 0 && (
                  <div className="detail-section">
                    <h3>People Involved</h3>
                    <div className="people-list">
                      {detail.people.map((p, i) => (
                        <span key={i} className="person-tag">{p}</span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.emails?.length === 0 && detail.meetings?.length === 0 && (
                  <div className="empty-state">No additional context found for this event.</div>
                )}
              </>
            ) : (
              <div className="empty-state">Could not load deal context.</div>
            )}
          </div>
        </>
      )}
    </>
  );
}
