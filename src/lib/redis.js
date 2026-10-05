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

const buildGetCacheKey = async (req) => {
  const ver = await getVersion();
  const userId = req?.user?.id ?? "anon";
  const role = req?.user?.role ?? "unknown";
  const path = String(req?.originalUrl || req?.url || "")
    .split("?")[0]
    .replace(/\/+$/, "")
    .toLowerCase();
  const query = stableQuery(req?.query);
  return `api:get:${ver}:${userId}:${role}:${path}?${query}`;
};

/** Binary / streaming GET paths — do not cache. */
const SKIP_GET_CACHE_RE =
  /\/(chat\/audio|chat\/file|request\/sanitary-image|file\/)(\/|$)/i;

const shouldSkipGetCache = (req) => {
  if (String(req?.method || "").toUpperCase() !== "GET") return true;
  const path = String(req?.originalUrl || req?.url || "").split("?")[0];
  return SKIP_GET_CACHE_RE.test(path);
};

const isMutatingMethod = (method) =>
  ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase());

module.exports = {
  getRedis,
  safeGet,
  safeSet,
  getVersion,
  invalidateAllGetCache,
  buildGetCacheKey,
  shouldSkipGetCache,
  isMutatingMethod,
  GET_TTL_SECONDS,
};
