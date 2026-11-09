require("../config/env");
const { PrismaClient } = require("@prisma/client");

const globalForPrisma = globalThis;

const createPrismaClient = () =>
  new PrismaClient({
    log: ["error"],
  });

// Avoid leaking pooled connections across nodemon reloads.
if (globalForPrisma.__prisma && typeof globalForPrisma.__prisma.$disconnect === "function") {
  globalForPrisma.__prisma.$disconnect().catch(() => {});
}

const prisma = createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
