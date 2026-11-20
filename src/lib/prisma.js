require("../config/env");
const { PrismaClient } = require("@prisma/client");
const { emitDbChange, shouldEmitAction, pickId } = require("./socket");

const globalForPrisma = globalThis;

const basePrisma =
  globalForPrisma.__prismaBase ||
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prismaBase = basePrisma;
}

const prisma =
  globalForPrisma.__prisma ||
  basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args);
          if (model && shouldEmitAction(operation)) {
            try {
              // createMany often notifies many users — emit per distinct scope key
              if (
                operation === "createMany" &&
                Array.isArray(args?.data) &&
                args.data.length > 0
              ) {
                const seen = new Set();
                args.data.forEach((row) => {
                  const siteId = row?.siteId ?? null;
                  const groupId = row?.groupId ?? null;
                  const userId = row?.userId ?? null;
                  const key = `${siteId}|${groupId}|${userId}`;
                  if (seen.has(key)) return;
                  seen.add(key);
                  emitDbChange({
                    table: model,
                    action: operation,
                    siteId,
                    groupId,
                    userId,
                    record: null,
                  });
                });
              } else {
                const record =
                  result &&
                  typeof result === "object" &&
                  !Array.isArray(result) &&
                  result.id != null
                    ? result
                    : null;
                emitDbChange({
                  table: model,
                  action: operation,
                  siteId: pickId("siteId", result, args),
                  groupId: pickId("groupId", result, args),
                  userId: pickId("userId", result, args),
                  record,
                });
              }
            } catch (err) {
              console.warn("Socket emit failed:", err?.message || err);
            }
          }
          return result;
        },
      },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}

const isTransientDbError = (error) => {
  const message = String(error?.message || error || "");
  return /Server has closed the connection|bytes remaining on stream|Can't reach database server|Connection reset|ECONNRESET|P1017|P1001|P1002/i.test(
    message,
  );
};

/** Retry once after reconnecting when the DB pooler drops the socket. */
const withDbRetry = async (fn) => {
  try {
    return await fn(prisma);
  } catch (error) {
    if (!isTransientDbError(error)) throw error;
    console.warn(
      "Transient DB connection error — reconnecting and retrying once:",
      error.message,
    );
    try {
      await prisma.$disconnect();
    } catch (_) {
      /* ignore */
    }
    await prisma.$connect();
    return await fn(prisma);
  }
};

module.exports = prisma;
module.exports.basePrisma = basePrisma;
module.exports.withDbRetry = withDbRetry;
module.exports.isTransientDbError = isTransientDbError;
