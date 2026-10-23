/**
 * Resolve request protocol behind proxies (Vercel).
 * Prefer X-Forwarded-Proto; force https for *.vercel.app hosts.
 */
const getRequestProtocol = (req) => {
  const forwarded = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;

  const host = String(req.get("host") || "").toLowerCase();
  if (host.includes("vercel.app") || host.includes("vercel.dev")) {
    return "https";
  }

  if (process.env.NODE_ENV === "production") return "https";

  return req.protocol || "http";
};

/** Absolute API base, e.g. https://host/api/v1 */
const getApiBaseUrl = (req) => {
  const protocol = getRequestProtocol(req);
  const host = req.get("host");
  return `${protocol}://${host}/api/v1`;
};

module.exports = {
  getRequestProtocol,
  getApiBaseUrl,
};
