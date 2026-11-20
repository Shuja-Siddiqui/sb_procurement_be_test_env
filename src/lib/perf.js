/**
 * Lightweight performance timing for API + DB spans.
 * Logs slow spans so we can separate DB time from total request time.
 */

const SLOW_DB_MS = Number(process.env.LOG_SLOW_DB_MS) || 200;
const SLOW_API_MS = Number(process.env.LOG_SLOW_API_MS) || 1000;

const nowNs = () => process.hrtime.bigint();
const nsToMs = (ns) => Number(ns) / 1e6;

/**
 * Time an async DB / Prisma call and log when slow.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ siteId?: number|string, meta?: object }} [ctx]
 * @returns {Promise<T>}
 */
const timedDb = async (label, fn, ctx = {}) => {
  const started = nowNs();
  try {
    return await fn();
  } finally {
    const ms = Math.round(nsToMs(nowNs() - started) * 100) / 100;
    if (ms >= SLOW_DB_MS) {
      const extra = ctx.siteId != null ? ` siteId=${ctx.siteId}` : "";
      console.warn(
        `[DB] ${label} | time=${ms}ms${extra}${
          ctx.meta ? ` | ${JSON.stringify(ctx.meta)}` : ""
        }`,
      );
    }
  }
};

/** Attach total + optional dbMs summary on response finish. */
const attachRequestTiming = (req, res, label) => {
  const started = nowNs();
  let dbMs = 0;
  req.__perfAddDbMs = (ms) => {
    dbMs += Number(ms) || 0;
  };

  const finish = () => {
    if (res.__perfLogged) return;
    res.__perfLogged = true;
    const totalMs = Math.round(nsToMs(nowNs() - started) * 100) / 100;
    if (totalMs < SLOW_API_MS && dbMs < SLOW_DB_MS) return;
    console.warn(
      `[PERF] ${label || req.method + " " + (req.originalUrl || req.url)}` +
        ` | total=${totalMs}ms | db≈${Math.round(dbMs * 100) / 100}ms` +
        ` | status=${res.statusCode}`,
    );
  };
  res.on("finish", finish);
  res.on("close", finish);
};

/**
 * timedDb that also accumulates onto req.__perfAddDbMs when present.
 */
const timedDbForReq = async (req, label, fn, ctx = {}) => {
  const started = nowNs();
  try {
    return await fn();
  } finally {
    const ms = nsToMs(nowNs() - started);
    if (typeof req?.__perfAddDbMs === "function") req.__perfAddDbMs(ms);
    if (ms >= SLOW_DB_MS) {
      const rounded = Math.round(ms * 100) / 100;
      const extra = ctx.siteId != null ? ` siteId=${ctx.siteId}` : "";
      console.warn(`[DB] ${label} | time=${rounded}ms${extra}`);
    }
  }
};

module.exports = {
  timedDb,
  timedDbForReq,
  attachRequestTiming,
  SLOW_DB_MS,
  SLOW_API_MS,
};
