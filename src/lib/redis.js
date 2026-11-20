const { Redis } = require("@upstash/redis");

/** Default TTL for cached GET responses (writes bump version immediately). */
const GET_TTL_SECONDS = 120;

const CACHE_VER_KEY = "api:get:ver";

let redisClient = null;

const getRedis = () => {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redisClient = new Redis({ url, token });
  return redisClient;
};

const safeGet = async (key) => {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch (error) {
    console.error("[redis] get failed:", error?.message || error);
    return null;
  }
};

const safeSet = async (key, value, ttlSeconds = GET_TTL_SECONDS) => {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
    return true;
  } catch (error) {
    console.error("[redis] set failed:", error?.message || error);
    return false;
  }
};

const safeDel = async (key) => {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.del(key);
    return true;
  } catch (error) {
    console.error("[redis] del failed:", error?.message || error);
    return false;
  }
};

const getVersion = async () => {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const value = await redis.get(CACHE_VER_KEY);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    console.error("[redis] version get failed:", error?.message || error);
    return 0;
  }
};

/** Bump version so all prior GET cache keys miss. */
const invalidateAllGetCache = async () => {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.incr(CACHE_VER_KEY);
  } catch (error) {
    console.error("[redis] version bump failed:", error?.message || error);
  }
};

const stableQuery = (query = {}) => {
  const entries = Object.entries(query || {})
    .filter(([key]) => key !== "dashboardCache")
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, [...value].map(String).sort().join(",")];
      }
      return [key, String(value ?? "")];
    })
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
};

/** Binary / streaming paths — do not cache response bodies. */
const SKIP_GET_CACHE_RE =
  /\/(chat\/audio|chat\/file|request\/sanitary-image|dailyupdate\/photos\/file|file\/)(\/|$)/i;

/** POST endpoints that are read-only list queries (safe to cache, must not invalidate). */
const READ_LIKE_POST_RE =
  /\/(request\/by-stage|stagematerial\/bulk)\/?$/i;

const normalizePath = (req) =>
  String(req?.originalUrl || req?.url || "")
    .split("?")[0]
    .replace(/\/+$/, "")
    .toLowerCase();

const isReadLikePost = (req) => {
  const method = String(req?.method || "").toUpperCase();
  if (method !== "POST") return false;
  return READ_LIKE_POST_RE.test(normalizePath(req));
};

const shouldSkipGetCache = (req) => {
  const method = String(req?.method || "").toUpperCase();
  const path = normalizePath(req);
  if (SKIP_GET_CACHE_RE.test(path)) return true;
  if (method === "GET") return false;
  if (isReadLikePost(req)) return false;
  return true;
};

const isMutatingMethod = (method, req) => {
  const m = String(method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) return false;
  // Read-style POSTs must not bump the global cache version.
  if (req && isReadLikePost(req)) return false;
  return true;
};

const stableBody = (body = {}) => {
  try {
    if (body == null || typeof body !== "object") return String(body ?? "");
    const normalized = {};
    Object.keys(body)
      .sort()
      .forEach((key) => {
        const value = body[key];
        if (value == null || value === "") return;
        if (typeof value === "object") {
          normalized[key] = JSON.stringify(value);
        } else {
          normalized[key] = String(value);
        }
      });
    return JSON.stringify(normalized);
  } catch {
    return "";
  }
};

const buildGetCacheKey = async (req) => {
  const ver = await getVersion();
  const userId = req?.user?.id ?? "anon";
  const role = req?.user?.role ?? "unknown";
  const path = normalizePath(req);
  const query = stableQuery(req?.query);
  const body =
    String(req?.method || "").toUpperCase() === "POST"
      ? stableBody(req?.body)
      : "";
  return `api:get:${ver}:${userId}:${role}:${path}?${query}&b=${body}`;
};

module.exports = {
  getRedis,
  safeGet,
  safeSet,
  safeDel,
  getVersion,
  invalidateAllGetCache,
  buildGetCacheKey,
  shouldSkipGetCache,
  isMutatingMethod,
  isReadLikePost,
  GET_TTL_SECONDS,
};
