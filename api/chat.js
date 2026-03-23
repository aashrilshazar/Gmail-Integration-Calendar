export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { messages, context } = req.body || {};
  if (!messages || !context) {
    return res.status(400).json({ error: "Provide messages and context" });
  }

  const emailContext = (context.emails || []).slice(0, 30).map(e =>
    `[${e.date}] From: ${e.from} | To: ${e.to} | Subject: ${e.subject} — ${e.snippet}`
  ).join("\n");

  const calendarContext = (context.calendarEvents || []).map(e =>
    `[${e.start}] ${e.title} — ${e.attendees.map(a => a.name || a.email).join(", ")}`
  ).join("\n");

  const system = `You are a sales operations analyst at Keye, an AI-powered due diligence platform for PE firms. Answer questions about Keye's relationship with "${context.firm}" using only the data below. Be direct and specific — name names and dates. If something cannot be determined from the context, say so clearly. Do not speculate.

EMAIL HISTORY:
${emailContext || "None."}

MEETING HISTORY:
${calendarContext || "None."}

AI SUMMARY:
${context.summary || "None."}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system,
        messages,
      }),
    });

    const data = await response.json();
    res.json({ answer: data.content?.[0]?.text || "Could not generate a response." });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
}
