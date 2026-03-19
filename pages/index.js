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

const ACCOUNT_HEX = ["#039be5", "#7986cb", "#33b679", "#e67c73"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 52; // px per hour, matches reference repo

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
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function formatHourLabel(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function formatMonthYear(monday) {
  const sunday = addDays(monday, 6);
  if (monday.getMonth() === sunday.getMonth()) {
    return monday.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return `${monday.toLocaleDateString("en-US", { month: "short" })} – ${sunday.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
}

function guessCompany(title) {
  let clean = title
    .replace(/^(meeting|call|sync|demo|intro|check-in|standup|1:1)\s*(with|:|-|–)?\s*/i, "")
    .replace(/\s*(meeting|call|sync|demo|intro|check-in)$/i, "")
    .trim();
  return clean || title;
}

// Layout overlapping events into columns, expanding to fill free space
function layoutEvents(dayEvents) {
  if (dayEvents.length === 0) return [];
  const items = dayEvents.map(e => {
    const s = new Date(e.start);
    const en = new Date(e.end);
    return { event: e, startH: s.getHours() + s.getMinutes() / 60, endH: en.getHours() + en.getMinutes() / 60 };
  }).sort((a, b) => a.startH - b.startH || a.endH - b.endH);

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
    let span = col + 1;
    for (let c = col + 1; c < totalCols; c++) {
      const conflict = columns[c].some(o => o.startH < item.endH && o.endH > item.startH);
      if (conflict) break;
      span = c + 1;
    }
    const top = item.startH * HOUR_HEIGHT;
    const height = Math.max((item.endH - item.startH) * HOUR_HEIGHT, 20);
    const widthPct = ((span - col) / totalCols) * 98;
    const leftPct = (col / totalCols) * 98;
    return {
      event: item.event,
      style: {
        top: `${top}px`,
        height: `${height}px`,
        width: `calc(${widthPct}%)`,
        left: `calc(${leftPct}%)`,
      },
    };
  });
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
  const [weekLoading, setWeekLoading] = useState(false);
  const fetchedDetails = useRef(new Set());
  const gridRef = useRef(null);

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

  // Pre-fetch event details (3 concurrent)
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
    fetchNext(); fetchNext(); fetchNext();
  }, [allEvents]);

  // Filter events to current week
  const events = allEvents.filter(e => {
    const d = new Date(e.start);
    return d >= weekStart && d < addDays(weekStart, 7);
  });

  // Navigation
  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));
  const goToday = () => setWeekStart(getMonday(new Date()));

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
  const nowTop = nowHour * HOUR_HEIGHT;

  // Scroll to ~8am on mount
  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.scrollTop = 7 * HOUR_HEIGHT;
    }
  }, [loading]);

  function eventsForDay(dayDate) {
    const dayStr = dayDate.toDateString();
    return events.filter(e => new Date(e.start).toDateString() === dayStr);
  }

  // Open event detail
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

  const closeDetail = () => { setSelectedEvent(null); setDetail(null); };

  return (
    <>
      <Head>
        <title>Keyesight — Calendar</title>
      </Head>

      {/* HEADER */}
      <div className="cal-header">
        <div className="cal-header__left">
          <h1 className="cal-header__title">Keyesight</h1>
          <button className="cal-btn cal-btn--outlined" onClick={goToday}>Today</button>
          <button className="cal-btn cal-btn--icon" onClick={prevWeek}>&#8249;</button>
          <button className="cal-btn cal-btn--icon" onClick={nextWeek}>&#8250;</button>
          <span className="cal-header__month">{formatMonthYear(weekStart)}</span>
        </div>
        <div className="cal-header__right">
          {ACCOUNTS.map((acc, i) => (
            <span key={acc} className="cal-legend">
              <span className="cal-legend__dot" style={{ background: ACCOUNT_HEX[i] }} />
              {acc.split("@")[0]}
            </span>
          ))}
        </div>
      </div>

      {/* LOAD EVENTS */}
      {!loading && !weekFetched && (
        <div className="cal-load-bar">
          <button className="cal-btn cal-btn--primary" onClick={loadWeekEvents} disabled={weekLoading}>
            {weekLoading ? "Loading…" : "Load Events"}
          </button>
        </div>
      )}

      {/* WEEK VIEW */}
      <div className="cal-wrapper">
        {/* DAY HEADERS (sticky) */}
        <div className="cal-day-headers">
          <div className="cal-time-gutter cal-time-gutter--header" />
          <div className="cal-day-columns">
            {days.map((day, i) => {
              const isToday = day.toDateString() === todayStr;
              return (
                <div key={i} className="cal-day-header">
                  <div className={`cal-day-header__name${isToday ? " cal-day-header__name--today" : ""}`}>
                    {day.toLocaleDateString("en-US", { weekday: "short" })}
                  </div>
                  <div className={`cal-day-header__num${isToday ? " cal-day-header__num--today" : ""}`}>
                    {day.getDate()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* SCROLLABLE GRID */}
        <div className="cal-grid-scroll" ref={gridRef}>
          <div className="cal-grid">
            {/* Time labels */}
            <div className="cal-time-gutter">
              {HOURS.map(h => (
                <div key={h} className="cal-time-label" style={{ height: HOUR_HEIGHT }}>
                  {h > 0 && <span>{formatHourLabel(h)}</span>}
                </div>
              ))}
            </div>

            {/* Day columns */}
            <div className="cal-day-columns">
              {days.map((day, di) => (
                <div key={di} className="cal-day-col">
                  {/* Hour grid lines */}
                  {HOURS.map(h => (
                    <div key={h} className="cal-hour-line" style={{ height: HOUR_HEIGHT }} />
                  ))}

                  {/* Current time indicator */}
                  {day.toDateString() === todayStr && (
                    <div className="cal-now-line" style={{ top: `${nowTop}px` }} />
                  )}

                  {/* Events */}
                  {!loading && layoutEvents(eventsForDay(day)).map(({ event, style }, ei) => (
                    <button
                      key={`${event.id}-${ei}`}
                      className="cal-slot"
                      style={{
                        ...style,
                        backgroundColor: ACCOUNT_HEX[ACCOUNT_COLORS[event.account] ?? 0],
                        borderLeft: `4px solid ${ACCOUNT_HEX[ACCOUNT_COLORS[event.account] ?? 0]}`,
                      }}
                      onClick={() => openDetail(event)}
                    >
                      <div className="cal-slot__text">
                        <span className="cal-slot__title">{event.title}</span>
                        <span className="cal-slot__time">{formatTime(event.start)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div className="cal-loading">Loading calendar…</div>
      )}

      {/* DETAIL PANEL */}
      {selectedEvent && (
        <>
          <div className="cal-overlay" onClick={closeDetail} />
          <div className="cal-detail">
            <div className="cal-detail__header">
              <div>
                <h2>{selectedEvent.title}</h2>
                <div className="cal-detail__account">{selectedEvent.account}</div>
              </div>
              <button className="cal-detail__close" onClick={closeDetail}>✕</button>
            </div>
            <div className="cal-detail__meta">
              <div>📅 {formatDate(selectedEvent.start)} · {formatTime(selectedEvent.start)} – {formatTime(selectedEvent.end)}</div>
              {selectedEvent.location && <div>📍 {selectedEvent.location}</div>}
              {selectedEvent.hangoutLink && (
                <div>🔗 <a href={selectedEvent.hangoutLink} target="_blank" rel="noreferrer">Join Google Meet</a></div>
              )}
            </div>

            {detailLoading ? (
              <div className="cal-detail__loading">Pulling deal context…</div>
            ) : detail ? (
              <>
                {detail.summary && (
                  <div className="cal-detail__section">
                    <h3>AI Summary</h3>
                    <ul className="cal-detail__bullets">
                      {detail.summary.split("\n").filter(l => l.trim().replace(/^-\s*/, "")).map((line, i) => (
                        <li key={i}>{line.trim().replace(/^-\s*/, "")}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {selectedEvent.attendees?.length > 0 && (
                  <div className="cal-detail__section">
                    <h3>Attendees</h3>
                    <div className="cal-detail__tags">
                      {selectedEvent.attendees.map((a, i) => (
                        <span key={i} className="cal-tag">
                          {a.name || a.email}
                          {a.status === "accepted" ? " ✓" : a.status === "declined" ? " ✗" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.emails?.length > 0 && (
                  <div className="cal-detail__section">
                    <h3>Email Threads ({detail.emails.length})</h3>
                    {detail.emails.map((email, i) => (
                      <div key={i} className="cal-email">
                        <div className="cal-email__subject">{email.subject}</div>
                        <div className="cal-email__meta">{email.from} · {email.date}</div>
                        {email.snippet && <div className="cal-email__snippet">{email.snippet}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {detail.meetings?.length > 0 && (
                  <div className="cal-detail__section">
                    <h3>Meeting Transcripts ({detail.meetings.length})</h3>
                    {detail.meetings.map((m, i) => (
                      <div key={i} className="cal-email">
                        <div className="cal-email__subject">{m.name}</div>
                        <div className="cal-email__meta">{m.date}</div>
                        {m.summary && <div className="cal-email__snippet">{m.summary}</div>}
                        {m.tasks && <div className="cal-email__snippet" style={{ color: "#33b679" }}>Tasks: {m.tasks}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {detail.people?.length > 0 && (
                  <div className="cal-detail__section">
                    <h3>People Involved</h3>
                    <div className="cal-detail__tags">
                      {detail.people.map((p, i) => (
                        <span key={i} className="cal-tag">{p}</span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.emails?.length === 0 && detail.meetings?.length === 0 && (
                  <div className="cal-detail__empty">No additional context found for this event.</div>
                )}
              </>
            ) : (
              <div className="cal-detail__empty">Could not load deal context.</div>
            )}
          </div>
        </>
      )}
    </>
  );
}
