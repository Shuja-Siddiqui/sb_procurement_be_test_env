const { decode, sign } = require("jsonwebtoken");
const {
  safeGet,
  safeSet,
  buildGetCacheKey,
  shouldSkipGetCache,
  invalidateAllGetCache,
  isMutatingMethod,
} = require("../lib/redis");

const refreshToken = (req) => {
  try {
    const auth = req?.headers?.authorization;
    if (!auth || auth === "undefined") return null;
    const t = auth.split(" ")[1];
    if (!t) return null;
    const decoded = decode(t);
    if (!decoded) return null;
    delete decoded.iat;
    delete decoded.exp;
    return sign(decoded, process.env.JWT_SECRET, { expiresIn: "30d" });
  } catch {
    return null;
  }
};

const wrapJsonOnce = (res, wrapper) => {
  if (res.__redisJsonWrapped) return;
  res.__redisJsonWrapped = true;
  const originalJson = res.json.bind(res);
  res.json = (body) => wrapper(body, originalJson);
};

/**
 * Global Redis layer for ALL /api/v1 methods:
 * - GET: serve/store JSON responses (per user + path + query)
 * - POST / PUT / PATCH / DELETE: always run handler; on success await cache invalidation
 *   so the next GET returns fresh DB data
 */
const redisCache = async (req, res, next) => {
  const method = String(req.method || "").toUpperCase();

  // --- POST / PUT / PATCH / DELETE: invalidate GET cache after success ---
  if (isMutatingMethod(method)) {
    wrapJsonOnce(res, (body, originalJson) => {
      const code = res.statusCode || 200;
      if (code >= 200 && code < 300) {
        // Await bump so an immediate follow-up GET cannot hit a stale key
        return invalidateAllGetCache()
          .then(() => originalJson(body))
          .catch(() => originalJson(body));
      }
      return originalJson(body);
    });
    return next();
  }

  // --- GET: cache JSON responses (skip binary endpoints) ---
  if (shouldSkipGetCache(req)) {
    return next();
  }

  // Need authenticated user for safe per-user keys; auth middleware sets req.user first
  if (!req.user?.id) {
    return next();
  }

  let cacheKey;
  try {
    cacheKey = await buildGetCacheKey(req);
  } catch (error) {
    console.error("[redis] key build failed:", error?.message || error);
    return next();
  }

  const cached = await safeGet(cacheKey);
  if (cached != null && typeof cached === "object") {
    const status = Number(cached.status) || 200;
    const token = refreshToken(req);
    return res.status(status).json({ ...cached, token });
  }

  wrapJsonOnce(res, (body, originalJson) => {
    const code = res.statusCode || 200;
    if (code >= 200 && code < 300 && body && typeof body === "object") {
      const { token: _token, ...toCache } = body;
      safeSet(cacheKey, toCache).catch(() => {});
    }
    return originalJson(body);
  });

  return next();
};

module.exports = redisCache;
