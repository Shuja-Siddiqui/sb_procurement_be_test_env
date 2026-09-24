const { Role } = require("@prisma/client");
const prisma = require("./prisma");

const normalizeRole = (role) => {
  const raw = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (raw === "site_supervisor" || raw === "super_visor") return Role.SUPERVISOR;
  if (raw === "super_admin") return Role.SUPER_ADMIN;
  if (raw === "sr_engineer" || raw === "sr._engineer") return Role.SR_ENGINEER;
  if (raw === "accountant") return Role.ACCOUNT;
  return String(raw).toUpperCase();
};

const GLOBAL_SITE_ACCESS_ROLES = new Set([
  Role.SUPER_ADMIN,
  Role.ADMIN,
  Role.DIRECTOR,
  Role.QA,
  Role.ACCOUNT,
]);

const canUserAccessSite = async ({ userId, role, siteId }) => {
  const parsedSiteId = Number(siteId);
  const parsedUserId = Number(userId);
  if (!Number.isFinite(parsedSiteId) || parsedSiteId <= 0) return false;
  if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) return false;

  const normalizedRole = normalizeRole(role);
  if (GLOBAL_SITE_ACCESS_ROLES.has(normalizedRole)) return true;

  if (normalizedRole === Role.SUPERVISOR) {
    const link = await prisma.siteSupervisor.findFirst({
      where: { siteId: parsedSiteId, userId: parsedUserId },
      select: { id: true },
    });
    return Boolean(link);
  }

  if (normalizedRole === Role.PURCHASER) {
    const link = await prisma.sitePurchaser.findFirst({
      where: { siteId: parsedSiteId, userId: parsedUserId },
      select: { id: true },
    });
    return Boolean(link);
  }

  if (normalizedRole === Role.SR_ENGINEER) {
    const link = await prisma.siteSeniorEngineer.findFirst({
      where: { siteId: parsedSiteId, userId: parsedUserId },
      select: { id: true },
    });
    return Boolean(link);
  }

  return false;
};

module.exports = {
  canUserAccessSite,
  normalizeRole,
};
