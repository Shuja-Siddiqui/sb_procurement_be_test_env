require("../config/env"); // ensure .env is loaded before reading LOG_DIR

const fs = require("fs");
const path = require("path");
const util = require("util");

const DEFAULT_LOG_DIR = "logs";
const DEFAULT_RETENTION_DAYS = 10;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

const getLogDir = () => {
  const raw = String(process.env.LOG_DIR || DEFAULT_LOG_DIR).trim();
  if (!raw) return DEFAULT_LOG_DIR;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return raw.replace(/^[/\\]+|[/\\]+$/g, "") || DEFAULT_LOG_DIR;
};

const getRetentionDays = () => {
  const parsed = Number(process.env.LOG_RETENTION_DAYS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_RETENTION_DAYS;
};

const LOG_DIR = getLogDir();
const LOG_ROOT = path.resolve(LOG_DIR);
const RETENTION_DAYS = getRetentionDays();

const ensureLogDir = () => {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
  return LOG_ROOT;
};

const pad2 = (n) => String(n).padStart(2, "0");

const formatDateStamp = (date = new Date()) => {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
};

const formatTimeStamp = (date = new Date()) => {
  const h = pad2(date.getHours());
  const m = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${formatDateStamp(date)} ${h}:${m}:${s}.${ms}`;
};

const logFilePathForDate = (date = new Date()) =>
  path.join(LOG_ROOT, `app-${formatDateStamp(date)}.log`);

const FILE_NAME_RE = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/i;

/**
 * Keep only the last N calendar days of log files.
 * Day 0 = today … day (N-1) kept; day N and older deleted.
 */
const cleanupOldLogs = () => {
  try {
    ensureLogDir();
    const entries = fs.readdirSync(LOG_ROOT, { withFileTypes: true });
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(FILE_NAME_RE);
      if (!match) continue;

      const fileDate = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        0,
        0,
        0,
        0,
      );
      if (Number.isNaN(fileDate.getTime())) continue;
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(LOG_ROOT, entry.name));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[logger] failed to delete ${entry.name}:`, err?.message || err);
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[logger] cleanup failed:", err?.message || err);
  }
};

const serializeArg = (arg) => {
  if (arg instanceof Error) {
    return `${arg.stack || arg.message || String(arg)}`;
  }
  if (typeof arg === "string") return arg;
  try {
    return util.inspect(arg, { depth: 5, colors: false, breakLength: 120 });
  } catch {
    return String(arg);
  }
};

const writeLine = (level, args) => {
  try {
    ensureLogDir();
    const line = `[${formatTimeStamp()}] [${String(level).toUpperCase()}] ${args
      .map(serializeArg)
      .join(" ")}\n`;
    fs.appendFileSync(logFilePathForDate(), line, "utf8");
  } catch (err) {
    // Avoid recursive logging loops — write to stderr only.
    try {
      process.stderr.write(
        `[logger] write failed: ${err?.message || err}\n`,
      );
    } catch {
      /* ignore */
    }
  }
};

const logger = {
  root: LOG_ROOT,
  retentionDays: RETENTION_DAYS,
  info: (...args) => writeLine("info", args),
  warn: (...args) => writeLine("warn", args),
  error: (...args) => writeLine("error", args),
  debug: (...args) => writeLine("debug", args),
  log: (...args) => writeLine("info", args),
  cleanup: cleanupOldLogs,
};

/** Mirror console.* into daily log files (still prints to terminal). */
const attachConsoleMirror = () => {
  if (global.__SB_LOG_CONSOLE_MIRRORED__) return;
  global.__SB_LOG_CONSOLE_MIRRORED__ = true;

  const levels = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ];

  for (const [method, level] of levels) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      writeLine(level, args);
    };
  }
};

const SLOW_API_MS = Number(process.env.LOG_SLOW_API_MS) || 1000;

/** Express access logger → daily log file + console (includes API response time). */
const requestLogger = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  const logAccess = () => {
    if (res.__sbAccessLogged) return;
    res.__sbAccessLogged = true;

    const elapsedNs = process.hrtime.bigint() - startedAt;
    const durationMs = Number(elapsedNs) / 1e6;
    const tookMs = Math.round(durationMs * 100) / 100; // 2 decimal places
    const pathName = req.originalUrl || req.url || "/";
    const userPart =
      req.user?.id != null ? ` | user=${req.user.id}` : "";
    const bytes = res.getHeader("content-length");
    const sizePart = bytes != null ? ` | size=${bytes}B` : "";
    const slowPart = tookMs >= SLOW_API_MS ? " | SLOW" : "";

    const line =
      `[API] ${req.method} ${pathName} | status=${res.statusCode}` +
      ` | time=${tookMs}ms${sizePart}${userPart}${slowPart}`;

    // Terminal + daily file (console is mirrored after initLogger).
    if (res.statusCode >= 500 || tookMs >= SLOW_API_MS * 3) {
      console.error(line);
    } else if (res.statusCode >= 400 || tookMs >= SLOW_API_MS) {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  res.on("finish", logAccess);
  res.on("close", logAccess);
  next();
};

let cleanupTimer = null;

const initLogger = () => {
  ensureLogDir();
  cleanupOldLogs();
  attachConsoleMirror();

  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupOldLogs, CLEANUP_INTERVAL_MS);
    if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
  }

  console.log(
    `[logger] ready → dir=${LOG_ROOT} retention=${RETENTION_DAYS}d`,
  );
  return logger;
};

module.exports = {
  logger,
  initLogger,
  requestLogger,
  cleanupOldLogs,
  LOG_ROOT,
  RETENTION_DAYS,
};
