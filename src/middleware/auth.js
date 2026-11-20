const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const redisCache = require("./redisCache");
const { safeGet, safeSet } = require("../lib/redis");

const AUTH_USER_TTL_SECONDS = Number(process.env.AUTH_USER_CACHE_TTL_SECONDS) || 60;

const authenticateJWTCore = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Access token missing or invalid" });
  }

  const token = authHeader.split(" ")[1];
  if (
    !token ||
    token === "null" ||
    token === "undefined" ||
    token.trim() === ""
  ) {
    return res.status(401).json({ message: "Access token missing or invalid" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = Number(decoded?.id);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const cacheKey = `auth:user:${userId}`;
    let user = await safeGet(cacheKey);
    if (!user || typeof user !== "object" || !user.id) {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          role: true,
          status: true,
          isEdit: true,
        },
      });
      if (user) {
        await safeSet(cacheKey, user, AUTH_USER_TTL_SECONDS);
      }
    }

    if (!user) {
      return res.status(401).json({ message: "User not found or inactive" });
    }

    const status = String(user.status || "").trim().toLowerCase();
    if (status && status !== "active") {
      return res.status(401).json({ message: "User account is inactive" });
    }

    // Prefer live DB values over stale token claims
    req.user = {
      id: user.id,
      name: user.name,
      role: user.role,
      isEdit: user.isEdit,
    };
    next();
  } catch (err) {
    const expired = err?.name === "TokenExpiredError";
    return res.status(401).json({
      message: expired ? "Access token expired" : "Invalid or expired token",
    });
  }
};

/**
 * JWT auth, then Redis for GET / POST / PUT / PATCH / DELETE on every protected route.
 */
const authenticateJWT = (req, res, next) => {
  authenticateJWTCore(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return;
    return redisCache(req, res, next);
  });
};

module.exports = authenticateJWT;
