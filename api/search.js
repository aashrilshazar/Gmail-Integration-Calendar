export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { query, firm, summary, people } = req.body || {};
  if (!query) return res.status(400).json({ error: "Provide a query" });

  const knownContacts = (people || []).slice(0, 40).join(", ");
  const contextBlock = [
    firm ? `Firm: ${firm}` : null,
    summary ? `Keye's relationship summary: ${summary}` : null,
    knownContacts ? `Known contacts from emails/calendar: ${knownContacts}` : null,
  ].filter(Boolean).join("\n");

  const system = `You are a web research assistant for Keye, a PE-focused AI due diligence platform. Your job is to look up public information — titles, roles, teams, locations, prior experience, and background — using web search.

${contextBlock ? `CONTEXT FROM KEYE'S INTERNAL DATA:\n${contextBlock}\n\nUse this to inform your searches (e.g. search for the right person at the right firm). Do not describe or repeat this internal context in your answer — just use it to search more accurately.` : ""}

When researching a person:
1. Search the firm's website team/about page
2. Search LinkedIn for current role, team, location, and prior experience
3. Check recent news or press if relevant

Be concise and factual. Cite your sources (site name or URL). If you cannot find reliable public information, say so plainly.`;

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
          max_tokens: 4096,
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

      // Log block types for auditing
      console.log(`[search] iter=${i} stop=${data.stop_reason} blocks=${JSON.stringify((data.content || []).map(b => b.type))}`);

      // Concatenate ALL text blocks — search responses interleave text/tool_use/tool_result
      const allText = (data.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n\n")
        .trim();

      if (data.stop_reason === "end_turn") {
        return res.json({ answer: allText || "No results found." });
      }

      if (data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content });

        const toolUses = data.content.filter(b => b.type === "tool_use");
        if (!toolUses.length) {
          return res.json({ answer: allText || "No results found." });
        }

        // Pass tool_result blocks — for built-in web search, results are in tool_result content blocks
        const toolResults = toolUses.map(b => {
          const resultBlock = data.content.find(
            c => c.type === "tool_result" && c.tool_use_id === b.id
          );
          return {
            type: "tool_result",
            tool_use_id: b.id,
            content: resultBlock?.content ?? "",
          };
        });

        messages.push({ role: "user", content: toolResults });
      } else {
        return res.json({ answer: allText || "No results found." });
      }
    }

    res.json({ answer: "Search reached iteration limit." });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
}
