import crypto from "crypto";

export function getAuthToken() {
  const password = process.env.SITE_PASSWORD || "";
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  cookieHeader.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  });
  return cookies;
}

export function isAuthenticated(req) {
  if (!process.env.SITE_PASSWORD) return true; // no password set = open access
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies.keye_auth === getAuthToken();
}

export function requireAuth(req, res) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}
