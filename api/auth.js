import { getAuthToken, isAuthenticated } from "../lib/auth.js";

export default function handler(req, res) {
  // GET /api/auth — check if authenticated
  if (req.method === "GET") {
    return res.json({ authenticated: isAuthenticated(req) });
  }

  // POST /api/auth — login
  if (req.method === "POST") {
    const { password } = req.body || {};
    const expected = process.env.SITE_PASSWORD;

    if (!expected) {
      return res.json({ ok: true }); // no password configured
    }

    if (!password || password !== expected) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const token = getAuthToken();
    const maxAge = 60 * 60 * 24 * 30; // 30 days
    res.setHeader(
      "Set-Cookie",
      `keye_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`
    );
    return res.json({ ok: true });
  }

  // DELETE /api/auth — logout
  if (req.method === "DELETE") {
    res.setHeader(
      "Set-Cookie",
      "keye_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"
    );
    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}
