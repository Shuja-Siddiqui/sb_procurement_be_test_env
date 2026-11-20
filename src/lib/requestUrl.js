/**
 * Resolve request protocol behind proxies.
 * Prefer X-Forwarded-Proto; force https for known production hosts.
 */
const getRequestProtocol = (req) => {
  const forwarded = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;

  const host = String(req.get("host") || "").toLowerCase();
  if (
    host.includes("vercel.app") ||
    host.includes("vercel.dev") ||
    host.includes("syedbrothers.app")
  ) {
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

/** Server origin without /api/v1, e.g. https://host */
const getServerOrigin = (req) => {
  const protocol = getRequestProtocol(req);
  const host = req.get("host");
  return `${protocol}://${host}`;
};

module.exports = {
  getRequestProtocol,
  getApiBaseUrl,
  getServerOrigin,
};
