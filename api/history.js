import { Redis } from "@upstash/redis";

const redis = process.env.KV_REST_API_URL
  ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
  : null;

const KEY = "keye:recent_chats";
const MAX = 20;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET") {
    if (!redis) return res.json({ chats: [] });
    try {
      const raw = await redis.lrange(KEY, 0, MAX - 1);
      const chats = raw.map(c => (typeof c === "string" ? JSON.parse(c) : c));
      // Dedup by firm (keep most recent occurrence)
      const seen = new Set();
      const deduped = chats.filter(c => {
        const key = c.firm?.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return res.json({ chats: deduped });
    } catch (err) {
      console.error("History GET error:", err.message);
      return res.json({ chats: [] });
    }
  }

  if (req.method === "POST") {
    const { firm } = req.body || {};
    if (!firm) return res.status(400).json({ error: "Provide firm" });
    if (!redis) return res.json({ ok: true });
    try {
      const entry = JSON.stringify({ firm, ts: Date.now() });
      await redis.lpush(KEY, entry);
      await redis.ltrim(KEY, 0, MAX - 1);
      return res.json({ ok: true });
    } catch (err) {
      console.error("History POST error:", err.message);
      return res.json({ ok: true }); // fail silently — don't break the lookup
    }
  }

  res.status(405).end();
}
