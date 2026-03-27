import { Redis } from "@upstash/redis";
import { requireAuth } from "../lib/auth.js";

const redisUrl   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl ? new Redis({ url: redisUrl, token: redisToken }) : null;

const RECENTS_KEY = "keye:recent_chats";
const CHAT_TTL    = 60 * 60 * 24 * 7; // 7 days
const MAX_RECENTS = 20;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requireAuth(req, res)) return;

  // GET /api/history          → recent chats list
  // GET /api/history?id=xxx   → full chat data
  if (req.method === "GET") {
    if (!redis) return res.json(req.query?.id ? { chat: null } : { chats: [] });

    if (req.query?.id) {
      try {
        const raw = await redis.get(`keye:chat:${req.query.id}`);
        const chat = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
        return res.json({ chat });
      } catch (err) {
        console.error("History GET chat:", err.message);
        return res.json({ chat: null });
      }
    }

    try {
      const raw = await redis.lrange(RECENTS_KEY, 0, MAX_RECENTS - 1);
      const chats = raw.map(c => typeof c === "string" ? JSON.parse(c) : c);
      const seen = new Set();
      const deduped = chats.filter(c => {
        const k = c.firm?.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return res.json({ chats: deduped });
    } catch (err) {
      console.error("History GET list:", err.message);
      return res.json({ chats: [] });
    }
  }

  // POST /api/history  { action: "create", firm, context }  → { id }
  // POST /api/history  { action: "append", id, turn }       → { ok }
  if (req.method === "POST") {
    const { action, firm, context, id, turn } = req.body || {};
    if (!redis) return res.json({ ok: true, id: Date.now().toString() });

    if (action === "create") {
      if (!firm) return res.status(400).json({ error: "Provide firm" });
      const newId = Date.now().toString();
      const trimmedContext = context
        ? { ...context, emails: (context.emails || []).slice(0, 15) }
        : null;
      const chatData = { id: newId, firm, ts: Date.now(), context: trimmedContext, turns: [] };
      try {
        await redis.set(`keye:chat:${newId}`, JSON.stringify(chatData), { ex: CHAT_TTL });
        await redis.lpush(RECENTS_KEY, JSON.stringify({ id: newId, firm, ts: Date.now() }));
        await redis.ltrim(RECENTS_KEY, 0, MAX_RECENTS - 1);
        return res.json({ ok: true, id: newId });
      } catch (err) {
        console.error("History create:", err.message);
        return res.json({ ok: true, id: newId });
      }
    }

    if (action === "append") {
      if (!id || !turn) return res.status(400).json({ error: "Provide id and turn" });
      try {
        const raw = await redis.get(`keye:chat:${id}`);
        const chat = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
        if (!chat) return res.json({ ok: true });
        chat.turns = [...(chat.turns || []), turn];
        await redis.set(`keye:chat:${id}`, JSON.stringify(chat), { ex: CHAT_TTL });
        return res.json({ ok: true });
      } catch (err) {
        console.error("History append:", err.message);
        return res.json({ ok: true });
      }
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  res.status(405).end();
}
