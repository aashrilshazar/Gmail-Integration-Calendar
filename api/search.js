export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { query, firm } = req.body || {};
  if (!query) return res.status(400).json({ error: "Provide a query" });

  const system = `You are a research assistant for Keye, a PE-focused AI due diligence platform. Answer questions about people and firms using web search. When researching a person:
1. Search their firm's team/about page first
2. Search LinkedIn for title, team, location, and prior experience
3. Check recent news or press for additional context

Be concise and factual. Always cite your sources with the URL or site name. If you cannot find reliable information, say so clearly.${firm ? `\n\nCurrent firm context: ${firm}.` : ""}`;

  const messages = [{ role: "user", content: query }];

  try {
    for (let i = 0; i < 6; i++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system,
          messages,
        }),
      });

      const data = await response.json();

      if (data.error) {
        console.error("Search API error:", JSON.stringify(data));
        return res.status(500).json({ error: data.error.message });
      }

      const textBlock = data.content?.find(b => b.type === "text");

      if (data.stop_reason === "end_turn") {
        return res.json({ answer: textBlock?.text || "No results found." });
      }

      if (data.stop_reason === "tool_use") {
        // Add assistant turn to history
        messages.push({ role: "assistant", content: data.content });

        // Pass tool_result blocks back for each tool_use
        const toolUses = data.content.filter(b => b.type === "tool_use");
        if (!toolUses.length) {
          return res.json({ answer: textBlock?.text || "No results found." });
        }

        const toolResults = toolUses.map(b => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: b.result ?? "",
        }));

        messages.push({ role: "user", content: toolResults });
      } else {
        // Unexpected stop reason — return whatever text we have
        return res.json({ answer: textBlock?.text || "No results found." });
      }
    }

    res.json({ answer: "Search reached iteration limit." });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
}
