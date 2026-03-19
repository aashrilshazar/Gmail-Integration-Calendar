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
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

function guessCompany(title) {
  let clean = title
    .replace(/^(meeting|call|sync|demo|intro|check-in|standup|1:1)\s*(with|:|-|–)?\s*/i, "")
    .replace(/\s*(meeting|call|sync|demo|intro|check-in)$/i, "")
    .trim();
  return clean || title;
}

// Build a 42-cell month grid (Monday start)
function getMonthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let startDow = firstOfMonth.getDay(); // 0=Sun
  startDow = startDow === 0 ? 6 : startDow - 1; // Mon=0

  const cells = [];
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) {
    cells.push({ day: prevDays - i, otherMonth: true, date: new Date(year, month - 1, prevDays - i) });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, otherMonth: false, date: new Date(year, month, d) });
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, otherMonth: true, date: new Date(year, month + 1, d) });
  }
  return cells;
}

export default function Home() {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [allEvents, setAllEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(null);
  const [cardPos, setCardPos] = useState({ left: 0, top: 0 });
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailCache, setDetailCache] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const fetchedDetails = useRef(new Set());
  const fetchedMonths = useRef(new Set());
  const calendarRef = useRef(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const monthName = currentMonth.toLocaleDateString("en-US", { month: "long" });

  // Fetch events for current month range
  useEffect(() => {
    const key = `${year}-${month}`;
    if (fetchedMonths.current.has(key)) { setLoading(false); return; }

    setLoading(true);
    const start = new Date(year, month - 1, 1).toISOString();
    const end = new Date(year, month + 2, 1).toISOString();
    fetch(`/api/calendar?start=${start}&end=${end}`)
      .then(res => res.json())
      .then(data => {
        setAllEvents(prev => {
          const existing = new Set(prev.map(e => `${e.title}|${e.start}`));
          const fresh = (data.events || []).filter(e => !existing.has(`${e.title}|${e.start}`));
          return [...prev, ...fresh];
        });
        fetchedMonths.current.add(key);
        fetchedMonths.current.add(`${year}-${month - 1}`);
        fetchedMonths.current.add(`${year}-${month + 1}`);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [year, month]);

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

  // Navigation
  const prevMonth = () => { setCurrentMonth(new Date(year, month - 1, 1)); setSelectedDate(null); };
  const nextMonth = () => { setCurrentMonth(new Date(year, month + 1, 1)); setSelectedDate(null); };

  // Calendar grid
  const grid = getMonthGrid(year, month);
  const today = new Date();
  const todayStr = today.toDateString();

  function eventsForDate(date) {
    const dateStr = date.toDateString();
    return allEvents.filter(e => new Date(e.start).toDateString() === dateStr);
  }

  const monthEvents = allEvents.filter(e => {
    const d = new Date(e.start);
    return d.getMonth() === month && d.getFullYear() === year;
  }).sort((a, b) => new Date(a.start) - new Date(b.start));

  const filteredEvents = searchQuery
    ? monthEvents.filter(e =>
        e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.account.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : monthEvents;

  // Date click handler
  const handleDateClick = (cell, e) => {
    if (selectedDate && cell.date.toDateString() === selectedDate.toDateString()) {
      setSelectedDate(null);
      return;
    }
    if (cell.otherMonth) {
      setCurrentMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1));
    }
    const td = e.currentTarget;
    const container = calendarRef.current;
    if (td && container) {
      const tdRect = td.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      setCardPos({
        left: tdRect.left - cRect.left,
        top: tdRect.bottom - cRect.top + 8,
      });
    }
    setSelectedDate(cell.date);
  };

  const selectedDateEvents = selectedDate ? eventsForDate(selectedDate) : [];

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

  const closeDetail = () => {
    setSelectedEvent(null);
    setDetail(null);
  };

  return (
    <>
      <Head>
        <title>Keyesight — Calendar</title>
        <link
          rel="stylesheet"
          href="https://stackpath.bootstrapcdn.com/bootstrap/4.3.1/css/bootstrap.min.css"
          integrity="sha384-ggOyR0iXCbMQv3Xipma34MD+dH/1fQ784/j6cY/iJTQUOhcWr7x9JvoRxT2MZw1T"
          crossOrigin="anonymous"
        />
      </Head>

      <div className="container">
        <header>
          <h1>Keyesight Calendar</h1>
          <div className="legend">
            {ACCOUNTS.map((acc, i) => (
              <span key={acc} className="legend-item">
                <span className="legend-dot" style={{ background: ACCOUNT_HEX[i] }} />
                {acc.split("@")[0]}
              </span>
            ))}
          </div>
        </header>

        {/* CALENDAR */}
        <div ref={calendarRef} style={{ position: "relative" }}>
          <div style={{ marginBottom: 12 }}>
            <button className="ui-datepicker-prev" onClick={prevMonth}>Prev</button>
            <button className="ui-datepicker-next" onClick={nextMonth}>Next</button>
            <div className="ui-datepicker-title">{monthName} {year}</div>
          </div>

          <table className="datepicker-table">
            <thead>
              <tr>
                {DAY_NAMES.map(d => <th key={d}>{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }, (_, row) => (
                <tr key={row}>
                  {grid.slice(row * 7, row * 7 + 7).map((cell, i) => {
                    const isToday = cell.date.toDateString() === todayStr;
                    const isSelected = selectedDate && cell.date.toDateString() === selectedDate.toDateString();
                    const hasEvents = eventsForDate(cell.date).length > 0;
                    const eventCount = eventsForDate(cell.date).length;
                    return (
                      <td
                        key={i}
                        className={[
                          cell.otherMonth ? "other-month" : "",
                          isToday ? "today-cell" : "",
                          isSelected ? "ui-datepicker-current-day" : "",
                          hasEvents ? "has-events" : "",
                        ].filter(Boolean).join(" ")}
                        onClick={(e) => handleDateClick(cell, e)}
                      >
                        <a className={isSelected ? "ui-state-active" : ""}>{cell.day}</a>
                        {hasEvents && <span className="event-count">{eventCount}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Event popup card */}
          {selectedDate && selectedDateEvents.length > 0 && (
            <div className="card event-card" style={{ display: "block", left: cardPos.left, top: cardPos.top }}>
              <h6 className="card-date">
                {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h6>
              {selectedDateEvents.map((event, i) => (
                <div key={i} className="event-card-item" onClick={() => openDetail(event)}>
                  <span className="event-dot" style={{ background: ACCOUNT_HEX[ACCOUNT_COLORS[event.account] ?? 0] }} />
                  <div>
                    <div className="event-card-title">{event.title}</div>
                    <div className="event-card-time">
                      {formatTime(event.start)} – {formatTime(event.end)}
                      <span className="event-card-account"> · {event.account.split("@")[0]}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedDate && selectedDateEvents.length === 0 && (
            <div className="card event-card" style={{ display: "block", left: cardPos.left, top: cardPos.top }}>
              <h6 className="card-date">
                {selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h6>
              <div style={{ color: "#999", fontSize: 13 }}>No events</div>
            </div>
          )}
        </div>

        {/* SEARCH */}
        <input
          type="text"
          placeholder="Search Events"
          className="form-control"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ marginTop: 24, marginBottom: 16 }}
        />

        {/* EVENTS TABLE */}
        {loading ? (
          <div style={{ textAlign: "center", padding: 40, color: "#999" }}>Loading events...</div>
        ) : (
          <table className="table table-dark" id="events-list">
            <thead>
              <tr>
                <td>Date</td>
                <td>Event Name</td>
                <td>Account</td>
                <td>Time</td>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((event, i) => (
                <tr key={i} onClick={() => openDetail(event)} style={{ cursor: "pointer" }}>
                  <td>{new Date(event.start).toLocaleDateString()}</td>
                  <td>
                    <span className="table-dot" style={{ background: ACCOUNT_HEX[ACCOUNT_COLORS[event.account] ?? 0] }} />
                    {event.title}
                  </td>
                  <td>{event.account.split("@")[0]}</td>
                  <td>{formatTime(event.start)} – {formatTime(event.end)}</td>
                </tr>
              ))}
              {filteredEvents.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", color: "#999" }}>No events found</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* DETAIL PANEL */}
      {selectedEvent && (
        <>
          <div className="detail-overlay" onClick={closeDetail} />
          <div className="detail-panel">
            <div className="detail-header">
              <div>
                <h2>{selectedEvent.title}</h2>
                <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
                  {selectedEvent.account}
                </div>
              </div>
              <button className="close-btn" onClick={closeDetail}>✕</button>
            </div>
            <div className="detail-meta">
              <div>📅 {formatDate(selectedEvent.start)} · {formatTime(selectedEvent.start)} – {formatTime(selectedEvent.end)}</div>
              {selectedEvent.location && <div>📍 {selectedEvent.location}</div>}
              {selectedEvent.hangoutLink && (
                <div>🔗 <a href={selectedEvent.hangoutLink} target="_blank" rel="noreferrer" style={{ color: "#006db3" }}>Join Google Meet</a></div>
              )}
            </div>

            {detailLoading ? (
              <div className="detail-loading">
                <div className="spinner-border spinner-border-sm" role="status" />
                <span style={{ marginLeft: 8 }}>Pulling deal context…</span>
              </div>
            ) : detail ? (
              <>
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

                {selectedEvent.attendees?.length > 0 && (
                  <div className="detail-section">
                    <h3>Attendees</h3>
                    <div className="people-list">
                      {selectedEvent.attendees.map((a, i) => (
                        <span key={i} className="badge badge-secondary mr-1 mb-1">
                          {a.name || a.email}
                          {a.status === "accepted" ? " ✓" : a.status === "declined" ? " ✗" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

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

                {detail.meetings?.length > 0 && (
                  <div className="detail-section">
                    <h3>Meeting Transcripts ({detail.meetings.length})</h3>
                    {detail.meetings.map((m, i) => (
                      <div key={i} className="meeting-item">
                        <div className="meeting-name">{m.name}</div>
                        <div className="meeting-date">{m.date}</div>
                        {m.summary && <div className="meeting-summary">{m.summary}</div>}
                        {m.tasks && (
                          <div className="meeting-summary" style={{ color: "#33b679" }}>
                            Tasks: {m.tasks}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {detail.people?.length > 0 && (
                  <div className="detail-section">
                    <h3>People Involved</h3>
                    <div className="people-list">
                      {detail.people.map((p, i) => (
                        <span key={i} className="badge badge-secondary mr-1 mb-1">{p}</span>
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
