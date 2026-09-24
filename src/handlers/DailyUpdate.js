const Response = require("./Response");
const prisma = require("../lib/prisma");
const { Role } = require("@prisma/client");
const PushNotificationService = require("./PushNotificationService");

const toNumber = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeDateOnly = (input) => {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return normalized;
};

const getTodayUtcDateOnly = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const normalizeRole = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
const toTitleCase = (value) =>
  String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
const makeIssueId = () =>
  `iss_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const ALLOWED_DAILY_UPDATE_ROLES = new Set([
  "admin",
  "supervisor",
  "super_admin",
  "site_engineer",
  "sr_engineer",
  "director",
]);
const ISSUE_RESOLVE_ROLES = new Set([
  "admin",
  "super_admin",
  "supervisor",
  "sr_engineer",
  "site_engineer",
  "site_enginner",
]);

const pushNotificationService = new PushNotificationService();

class DailyUpdate extends Response {
  hasDailyUpdateAccess = (role) => ALLOWED_DAILY_UPDATE_ROLES.has(normalizeRole(role));

  getTemplateRows = async (siteId) => {
    const totalMaterial = await prisma.materialTotal.findUnique({
      where: { siteId },
    });
    const materialRows = Array.isArray(totalMaterial?.data) ? totalMaterial.data : [];
    return materialRows.map((item) => {
      const totalQty = toNumber(item.quantity ?? item.qty);
      const usedQty = toNumber(item.approved_qty ?? item.used_qty);
      const remainingQty =
        item?.remaining_material !== undefined
          ? toNumber(item.remaining_material)
          : Math.max(totalQty - usedQty, 0);
      return {
        productId: item.productId,
        // Keep for backward compatibility/debugging.
        system_site_qty: parseFloat(usedQty.toFixed(6)),
        prev_remaining_qty: 0,
        prev_site_used_qty: 0,
        opening_qty: 0,
        // Daily update "Received" should follow approved/used quantity.
        received_qty: parseFloat(usedQty.toFixed(6)),
        site_used_qty: 0,
        damaged_qty: 0,
        closing_qty: parseFloat(remainingQty.toFixed(6)),
        remarks: "",
      };
    });
  };

  mergeRows = (templateRows, payloadRows, previousRows = []) => {
    const previousMap = new Map((previousRows || []).map((row) => [row.productId, row]));
    const payloadMap = new Map((payloadRows || []).map((row) => [row.productId, row]));

    return templateRows.map((templateRow) => {
      const previous = previousMap.get(templateRow.productId);
      const payload = payloadMap.get(templateRow.productId) || {};

      const resolvedSystemSiteQty = payload.system_site_qty !== undefined
        ? toNumber(payload.system_site_qty)
        : toNumber(templateRow.system_site_qty);
      const previousRemainingQty = previous ? toNumber(previous.closing_qty) : 0;
      const previousUsedQty = previous ? toNumber(previous.site_used_qty) : 0;
      const received = payload.received_qty !== undefined
        ? toNumber(payload.received_qty)
        : toNumber(templateRow.received_qty ?? resolvedSystemSiteQty);
      const damaged = toNumber(payload.damaged_qty);
      const closing = payload.closing_qty !== undefined
        ? toNumber(payload.closing_qty)
        : previous
          ? toNumber(previous.closing_qty)
          : 0;
      const consumed = received - closing;

      return {
        productId: templateRow.productId,
        system_site_qty: parseFloat(resolvedSystemSiteQty.toFixed(6)),
        prev_remaining_qty: parseFloat(previousRemainingQty.toFixed(6)),
        prev_site_used_qty: parseFloat(previousUsedQty.toFixed(6)),
        opening_qty: parseFloat(previousRemainingQty.toFixed(6)),
        received_qty: parseFloat(received.toFixed(6)),
        site_used_qty: parseFloat(consumed.toFixed(6)),
        damaged_qty: parseFloat(damaged.toFixed(6)),
        closing_qty: parseFloat(closing.toFixed(6)),
        remarks: payload.remarks || "",
      };
    });
  };

  upsertBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.body.siteId);
      const date = normalizeDateOnly(req.body.date);
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }
      if (date.getTime() > getTodayUtcDateOnly().getTime()) {
        return this.sendResponse(req, res, {
          message: "Future date is not allowed",
          status: 400,
        });
      }

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          message: "Site not found",
          status: 404,
        });
      }

      const previousDay = new Date(date);
      previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      const previousUpdate = await prisma.dailyMaterialUpdate.findUnique({
        where: { siteId_date: { siteId, date: previousDay } },
      });

      const templateRows = await this.getTemplateRows(siteId);
      const mergedRows = this.mergeRows(templateRows, rows, previousUpdate?.rows);
      const hasInvalidRemainingQty = mergedRows.some(
        (row) => toNumber(row?.closing_qty) > toNumber(row?.received_qty),
      );
      if (hasInvalidRemainingQty) {
        return this.sendResponse(req, res, {
          message: "Remaining on site cannot be greater than received",
          status: 400,
        });
      }

      const saved = await prisma.dailyMaterialUpdate.upsert({
        where: { siteId_date: { siteId, date } },
        update: {
          rows: mergedRows,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
        create: {
          siteId,
          date,
          rows: mergedRows,
          createdBy: req.user?.id || null,
          createdByName: req.user?.name || null,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
      });

      return this.sendResponse(req, res, {
        message: "Daily update saved successfully",
        status: 200,
        data: saved,
      });
    } catch (error) {
      console.error("Error in daily update upsert:", error);
      return this.sendResponse(req, res, {
        message: "Failed to save daily update",
        status: 500,
        error: error.message,
      });
    }
  };

  getBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const date = normalizeDateOnly(req.query.date);

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }
      if (date.getTime() > getTodayUtcDateOnly().getTime()) {
        return this.sendResponse(req, res, {
          message: "Future date is not allowed",
          status: 400,
        });
      }

      const current = await prisma.dailyMaterialUpdate.findUnique({
        where: { siteId_date: { siteId, date } },
      });

      if (current) {
        // Always reflect latest Total Material values in "Received" when viewing
        // an existing daily update record.
        const templateRows = await this.getTemplateRows(siteId);
        const templateMap = new Map(
          templateRows.map((row) => [row.productId, row]),
        );
        const refreshedRows = (Array.isArray(current?.rows) ? current.rows : []).map(
          (row) => {
            const productId = row?.productId;
            const templateRow = templateMap.get(productId);
            if (!templateRow) return row;
            const latestReceived = toNumber(templateRow.received_qty);
            const nextClosing = Math.min(
              toNumber(row?.closing_qty),
              latestReceived,
            );
            return {
              ...row,
              system_site_qty: parseFloat(toNumber(templateRow.system_site_qty).toFixed(6)),
              received_qty: parseFloat(latestReceived.toFixed(6)),
              closing_qty: parseFloat(nextClosing.toFixed(6)),
              site_used_qty: parseFloat((latestReceived - nextClosing).toFixed(6)),
            };
          },
        );
        return this.sendResponse(req, res, {
          message: "Daily update fetched successfully",
          status: 200,
          data: {
            ...current,
            rows: refreshedRows,
          },
        });
      }

      const previousDay = new Date(date);
      previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      const previousUpdate = await prisma.dailyMaterialUpdate.findUnique({
        where: { siteId_date: { siteId, date: previousDay } },
      });

      const templateRows = await this.getTemplateRows(siteId);
      const draftRows = this.mergeRows(templateRows, [], previousUpdate?.rows);

      return this.sendResponse(req, res, {
        message: "Daily update template fetched successfully",
        status: 200,
        data: {
          siteId,
          date,
          rows: draftRows,
          isDraftTemplate: true,
        },
      });
    } catch (error) {
      console.error("Error in get daily update:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily update",
        status: 500,
      });
    }
  };

  getHistoryBySite = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 7, 1), 31);

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          message: "Valid siteId is required",
          status: 400,
        });
      }

      const records = await prisma.dailyMaterialUpdate.findMany({
        where: { siteId },
        orderBy: { date: "desc" },
        take: limit,
      });

      return this.sendResponse(req, res, {
        message: "Daily update history fetched successfully",
        status: 200,
        data: records,
      });
    } catch (error) {
      console.error("Error in get daily update history:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily update history",
        status: 500,
      });
    }
  };

  upsertIssuesBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.body.siteId);
      const date = normalizeDateOnly(req.body.date);
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
      const userRole = normalizeRole(req?.user?.role);

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }
      if (date.getTime() > getTodayUtcDateOnly().getTime()) {
        return this.sendResponse(req, res, {
          message: "Future date is not allowed",
          status: 400,
        });
      }

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          message: "Site not found",
          status: 404,
        });
      }

      const hasResolvedIssue = rows.some(
        (row) => String(row?.status || "").toLowerCase() === "resolved",
      );
      if (hasResolvedIssue && !ISSUE_RESOLVE_ROLES.has(userRole)) {
        return this.sendResponse(req, res, {
          message:
            "Only Admin, Super Admin, Supervisor, or Site Engineer can resolve issues",
          status: 403,
        });
      }

      const existingIssueRecord = await prisma.dailyIssueUpdate.findUnique({
        where: { siteId_date: { siteId, date } },
      });
      const previousRows = Array.isArray(existingIssueRecord?.rows) ? existingIssueRecord.rows : [];
      const previousRowsById = new Map(
        previousRows
          .filter((row) => String(row?.issueId || "").trim())
          .map((row) => [String(row.issueId), row])
      );
      const actorId = Number(req.user?.id) || null;
      const actorName = String(req.user?.name || "").trim() || null;
      const normalizedRows = rows.map((row) => {
        const incomingIssueId = String(row?.issueId || "").trim();
        const existingRow = incomingIssueId ? previousRowsById.get(incomingIssueId) : null;
        const issueId = incomingIssueId || makeIssueId();
        const createdBy = existingRow?.createdBy ?? actorId;
        const createdByName = existingRow?.createdByName ?? actorName;
        const createdAt = existingRow?.createdAt ?? new Date().toISOString();
        return {
          issueId,
          issueType: String(row?.issueType || "").trim(),
          explanation: String(row?.explanation || "").trim(),
          status: String(row?.status || "open").toLowerCase(),
          createdBy,
          createdByName,
          createdAt,
          updatedBy: actorId,
          updatedByName: actorName,
          updatedAt: new Date().toISOString(),
        };
      });
      const hasPreviouslyResolvedIssue = previousRows.some(
        (row) => String(row?.status || "").toLowerCase() === "resolved",
      );
      const hasNewResolvedIssue = hasResolvedIssue && !hasPreviouslyResolvedIssue;

      const saved = await prisma.dailyIssueUpdate.upsert({
        where: { siteId_date: { siteId, date } },
        update: {
          rows: normalizedRows,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
        create: {
          siteId,
          date,
          rows: normalizedRows,
          createdBy: req.user?.id || null,
          createdByName: req.user?.name || null,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
      });

      // Notify key roles when privileged roles create/update/resolve issues.
      if (
        [
          "admin",
          "super_admin",
          "director",
          "supervisor",
          "sr_engineer",
          "site_engineer",
          "site_enginner",
        ].includes(userRole)
      ) {
        const [roleBasedRecipients, siteEngineerRecipients, siteSupervisorRecipients] = await Promise.all([
          prisma.user.findMany({
            where: {
              role: {
                in: [Role.ADMIN, Role.SUPER_ADMIN, Role.SUPERVISOR, Role.SR_ENGINEER, Role.DIRECTOR],
              },
            },
            select: { id: true },
          }),
          prisma.siteSeniorEngineer.findMany({
            where: { siteId },
            select: { userId: true },
          }),
          prisma.siteSupervisor.findMany({
            where: { siteId },
            select: { userId: true },
          }),
        ]);
        const recipientIds = [
          ...new Set([
            ...roleBasedRecipients.map((user) => user.id),
            ...siteEngineerRecipients.map((user) => user.userId),
            ...siteSupervisorRecipients.map((user) => user.userId),
          ]),
        ];
        const actionText = existingIssueRecord ? "updated" : "created";
        const normalizedDateLabel = date.toISOString().split("T")[0];
        const actorLabelMap = {
          admin: "Admin",
          super_admin: "Super Admin",
          director: "Director",
          supervisor: "Supervisor",
          sr_engineer: "Sr Engineer",
          site_engineer: "Site Engineer",
          site_enginner: "Site Engineer",
        };
        const actorLabel = actorLabelMap[userRole] || "User";
        const issueSummary = rows
          .map((row, index) => {
            const explanation = String(row?.explanation || "").trim();
            const statusLabel = toTitleCase(row?.status || "open");
            if (!explanation) return null;
            return `${index + 1}. ${explanation} [${statusLabel}]`;
          })
          .filter(Boolean);
        const issueSummaryText =
          issueSummary.length > 0
            ? ` Issues: ${issueSummary.slice(0, 3).join(" | ")}${issueSummary.length > 3 ? " ..." : ""}`
            : "";
        const notificationBody = hasNewResolvedIssue
          ? `${req.user?.name || actorLabel} resolved issue(s) at site "${site.name}" on ${normalizedDateLabel}.${issueSummaryText}`
          : `${req.user?.name || actorLabel} ${actionText} daily issue(s) at site "${site.name}" on ${normalizedDateLabel}.${issueSummaryText}`;

        const dispatchResult = await pushNotificationService.dispatchNotifications({
          event: "DAILY_ISSUES_UPDATE",
          senderId: req.user?.id,
          recipientIds,
          title: site.name || "Daily Issues",
          body: notificationBody,
          type: "SiteActivity",
          data: {
            siteId,
            siteName: site.name || "",
            date: normalizedDateLabel,
            action: hasNewResolvedIssue ? "issue_resolved" : `issue_${actionText}`,
            issues: normalizedRows.map((row) => ({
              issueId: String(row?.issueId || ""),
              issueType: String(row?.issueType || ""),
              explanation: String(row?.explanation || ""),
              status: String(row?.status || "open"),
              createdBy: row?.createdBy ?? null,
              createdByName: String(row?.createdByName || ""),
              updatedBy: row?.updatedBy ?? null,
              updatedByName: String(row?.updatedByName || ""),
            })),
          },
        });
        console.log("[DailyIssues][NotificationDispatch]", {
          actorRole: userRole,
          siteId,
          date: normalizedDateLabel,
          recipients: recipientIds.length,
          created: dispatchResult?.createdCount || 0,
          skippedAsDuplicate: dispatchResult?.duplicateSkipped || 0,
        });
      }

      return this.sendResponse(req, res, {
        message: "Daily issues saved successfully",
        status: 200,
        data: saved,
      });
    } catch (error) {
      console.error("Error in daily issues upsert:", error);
      return this.sendResponse(req, res, {
        message: "Failed to save daily issues",
        status: 500,
        error: error.message,
      });
    }
  };

  getIssuesBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const date = normalizeDateOnly(req.query.date);

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }

      const record = await prisma.dailyIssueUpdate.findUnique({
        where: { siteId_date: { siteId, date } },
      });

      return this.sendResponse(req, res, {
        message: "Daily issues fetched successfully",
        status: 200,
        data: record || { siteId, date, rows: [] },
      });
    } catch (error) {
      console.error("Error in get daily issues:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily issues",
        status: 500,
      });
    }
  };

  getIssuesHistoryBySite = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          message: "Valid siteId is required",
          status: 400,
        });
      }

      const records = await prisma.dailyIssueUpdate.findMany({
        where: { siteId },
        orderBy: { date: "desc" },
        take: limit,
      });

      return this.sendResponse(req, res, {
        message: "Daily issues history fetched successfully",
        status: 200,
        data: records,
      });
    } catch (error) {
      console.error("Error in get daily issues history:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily issues history",
        status: 500,
      });
    }
  };

  upsertSiteProgressBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.body.siteId);
      const date = normalizeDateOnly(req.body.date);
      const stage = String(req.body.stage || "").trim();
      const workSummary = String(req.body.workSummary || "").trim();

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }
      if (!stage) {
        return this.sendResponse(req, res, {
          message: "Stage is required",
          status: 400,
        });
      }

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          message: "Site not found",
          status: 404,
        });
      }

      const saved = await prisma.dailySiteProgressUpdate.upsert({
        where: { siteId_date: { siteId, date } },
        update: {
          stage,
          workSummary,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
        create: {
          siteId,
          date,
          stage,
          workSummary,
          createdBy: req.user?.id || null,
          createdByName: req.user?.name || null,
          updatedBy: req.user?.id || null,
          updatedByName: req.user?.name || null,
        },
      });

      return this.sendResponse(req, res, {
        message: "Daily site progress saved successfully",
        status: 200,
        data: saved,
      });
    } catch (error) {
      console.error("Error in site progress upsert:", error);
      return this.sendResponse(req, res, {
        message: "Failed to save daily site progress",
        status: 500,
        error: error.message,
      });
    }
  };

  getSiteProgressBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const date = normalizeDateOnly(req.query.date);

      if (!Number.isFinite(siteId) || siteId <= 0 || !date) {
        return this.sendResponse(req, res, {
          message: "Valid siteId and date are required",
          status: 400,
        });
      }

      const record = await prisma.dailySiteProgressUpdate.findUnique({
        where: { siteId_date: { siteId, date } },
      });

      return this.sendResponse(req, res, {
        message: "Daily site progress fetched successfully",
        status: 200,
        data: record || {
          siteId,
          date,
          stage: "",
          workSummary: "",
        },
      });
    } catch (error) {
      console.error("Error in get daily site progress:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily site progress",
        status: 500,
      });
    }
  };

  getSiteProgressHistoryBySite = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const siteId = Number(req.params.siteId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          message: "Valid siteId is required",
          status: 400,
        });
      }

      const records = await prisma.dailySiteProgressUpdate.findMany({
        where: { siteId },
        orderBy: { date: "desc" },
        take: limit,
      });

      return this.sendResponse(req, res, {
        message: "Daily site progress history fetched successfully",
        status: 200,
        data: records,
      });
    } catch (error) {
      console.error("Error in get daily site progress history:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch daily site progress history",
        status: 500,
      });
    }
  };
}

module.exports = DailyUpdate;
