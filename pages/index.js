import { useState, useEffect, useCallback } from "react";
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

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7am - 8pm
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

function formatWeekRange(monday) {
  const sunday = addDays(monday, 6);
  const opts = { month: "short", day: "numeric" };
  const endOpts = monday.getMonth() === sunday.getMonth()
    ? { day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `${monday.toLocaleDateString("en-US", opts)} – ${sunday.toLocaleDateString("en-US", endOpts)}`;
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
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    const start = weekStart.toISOString();
    const end = addDays(weekStart, 7).toISOString();
    try {
      const res = await fetch(`/api/calendar?start=${start}&end=${end}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      console.error("Failed to fetch events:", err);
      setEvents([]);
    }
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const openDetail = async (event) => {
    setSelectedEvent(event);
    setDetail(null);
    setDetailLoading(true);
    const company = encodeURIComponent(guessCompany(event.title));
    try {
      const res = await fetch(`/api/event/detail?company=${company}&eventTitle=${encodeURIComponent(event.title)}`);
      const data = await res.json();
      setDetail(data);
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
  const nowTop = (nowHour - 7) * 60;

  // Position events on the grid
  function getEventStyle(event) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;
    const top = (startHour - 7) * 60; // 60px per hour, offset by 7am
    const height = Math.max((endHour - startHour) * 60, 20);
    return { top: `${top}px`, height: `${height}px` };
  }

  // Group events by day
  function eventsForDay(dayDate) {
    const dayStr = dayDate.toDateString();
    return events.filter(e => {
      const eDate = new Date(e.start);
      return eDate.toDateString() === dayStr;
    });
  }

  return (
    <>
      <Head>
        <title>Keyesight — Sales Calendar</title>
      </Head>

      {/* HEADER */}
      <div className="header">
        <h1>Keyesight <span>/ calendar</span></h1>
        <div className="nav-buttons">
          <button onClick={prevWeek}>← Prev</button>
          <button onClick={goToday}>Today</button>
          <span className="week-label">{formatWeekRange(weekStart)}</span>
          <button onClick={nextWeek}>Next →</button>
        </div>
        <div className="legend">
          {ACCOUNTS.map((acc, i) => (
            <div key={acc} className="legend-item">
              <div className="legend-dot" style={{ background: `var(--accent-${i + 1})` }} />
              {acc.split("@")[0]}
            </div>
          ))}
        </div>
      </div>

      {/* CALENDAR */}
      <div className="calendar-container">
        <div className="time-column">
          <div style={{ height: 48 }} />
          {HOURS.map(h => (
            <div key={h} className="time-label">
              {h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
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
                {day.toDateString() === todayStr && nowHour >= 7 && nowHour <= 21 && (
                  <div className="now-line" style={{ top: `${nowTop}px` }} />
                )}
                {!loading && eventsForDay(day).map((event, ei) => (
                  <div
                    key={`${event.id}-${ei}`}
                    className={`event-tile account-${ACCOUNT_COLORS[event.account] ?? 0}`}
                    style={getEventStyle(event)}
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
                    <div className="summary-text">{detail.summary}</div>
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
