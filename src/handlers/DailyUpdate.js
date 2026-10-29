const Response = require("./Response");
const prisma = require("../lib/prisma");
const { Role } = require("@prisma/client");
const PushNotificationService = require("./PushNotificationService");
const { getApiBaseUrl } = require("../lib/requestUrl");

const toNumber = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeProductId = (value) => String(value ?? "").trim();

const normalizeDateOnly = (input) => {
  if (!input) return getTodayUtcDateOnly();
  const raw = String(input).trim();
  // Prefer YYYY-MM-DD so local timezone never shifts the calendar day
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (ymd) {
    return new Date(
      Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])),
    );
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
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

  /**
   * Latest saved daily update strictly before the selected date.
   * (Not only date-1 — so remaining carries across skipped days.)
   */
  getLatestPreviousUpdate = async (siteId, date) => {
    if (!Number.isFinite(siteId) || !date) return null;
    return prisma.dailyMaterialUpdate.findFirst({
      where: {
        siteId,
        date: { lt: date },
      },
      orderBy: { date: "desc" },
    });
  };

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
    const previousMap = new Map(
      (previousRows || []).map((row) => [normalizeProductId(row.productId), row]),
    );
    const payloadMap = new Map(
      (payloadRows || []).map((row) => [normalizeProductId(row.productId), row]),
    );

    return templateRows.map((templateRow) => {
      const productKey = normalizeProductId(templateRow.productId);
      const previous = previousMap.get(productKey);
      const payload = payloadMap.get(productKey) || {};
      const hasPayloadClosing = payload.closing_qty !== undefined && payload.closing_qty !== null && payload.closing_qty !== "";

      const resolvedSystemSiteQty = payload.system_site_qty !== undefined
        ? toNumber(payload.system_site_qty)
        : toNumber(templateRow.system_site_qty);
      const previousRemainingQty = previous ? toNumber(previous.closing_qty) : 0;
      const previousUsedQty = previous ? toNumber(previous.site_used_qty) : 0;
      const received = payload.received_qty !== undefined
        ? toNumber(payload.received_qty)
        : toNumber(templateRow.received_qty ?? resolvedSystemSiteQty);
      const damaged = toNumber(payload.damaged_qty);
      // New day / draft: auto-fill Remaining on site from last saved remaining.
      // Explicit payload closing wins when the user is saving edits.
      let closing = hasPayloadClosing
        ? toNumber(payload.closing_qty)
        : previous
          ? previousRemainingQty
          : 0;
      if (closing > received) closing = received;
      if (closing < 0) closing = 0;
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

      const previousUpdate = await this.getLatestPreviousUpdate(siteId, date);

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

      const previousUpdate = await this.getLatestPreviousUpdate(siteId, date);
      const previousRows = Array.isArray(previousUpdate?.rows) ? previousUpdate.rows : [];
      const previousMap = new Map(
        previousRows.map((row) => [normalizeProductId(row.productId), row]),
      );

      if (current) {
        // Always reflect latest Total Material values in "Received" when viewing
        // an existing daily update record, and refresh previous remaining from
        // the latest prior daily update (so skipped days still show correctly).
        const templateRows = await this.getTemplateRows(siteId);
        const templateMap = new Map(
          templateRows.map((row) => [normalizeProductId(row.productId), row]),
        );
        const refreshedRows = (Array.isArray(current?.rows) ? current.rows : []).map(
          (row) => {
            const productKey = normalizeProductId(row?.productId);
            const templateRow = templateMap.get(productKey);
            const previous = previousMap.get(productKey);
            const previousRemainingQty = previous ? toNumber(previous.closing_qty) : 0;
            const previousUsedQty = previous ? toNumber(previous.site_used_qty) : 0;
            if (!templateRow) {
              return {
                ...row,
                prev_remaining_qty: parseFloat(previousRemainingQty.toFixed(6)),
                prev_site_used_qty: parseFloat(previousUsedQty.toFixed(6)),
                opening_qty: parseFloat(previousRemainingQty.toFixed(6)),
              };
            }
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
              prev_remaining_qty: parseFloat(previousRemainingQty.toFixed(6)),
              prev_site_used_qty: parseFloat(previousUsedQty.toFixed(6)),
              opening_qty: parseFloat(previousRemainingQty.toFixed(6)),
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

      const templateRows = await this.getTemplateRows(siteId);
      const draftRows = this.mergeRows(templateRows, [], previousRows);

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
        const incomingPhotoIds = Array.isArray(row?.photoIds)
          ? row.photoIds
              .map((id) => Number(id))
              .filter((id) => Number.isFinite(id) && id > 0)
          : null;
        const previousPhotoIds = Array.isArray(existingRow?.photoIds)
          ? existingRow.photoIds
              .map((id) => Number(id))
              .filter((id) => Number.isFinite(id) && id > 0)
          : [];
        const photoIds = [...new Set(incomingPhotoIds ?? previousPhotoIds)];
        const toNullableNumber = (value) => {
          if (value === "" || value == null) return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        return {
          issueId,
          issueType: String(row?.issueType || "").trim(),
          explanation: String(row?.explanation || "").trim(),
          reason: String(row?.reason ?? existingRow?.reason ?? "").trim(),
          remainingQty:
            toNullableNumber(row?.remainingQty) ??
            toNullableNumber(existingRow?.remainingQty),
          requestQty:
            toNullableNumber(row?.requestQty) ??
            toNullableNumber(existingRow?.requestQty),
          materialName: String(
            row?.materialName ?? existingRow?.materialName ?? "",
          ).trim(),
          productId:
            toNullableNumber(row?.productId) ??
            toNullableNumber(existingRow?.productId),
          stageNames: Array.isArray(row?.stageNames)
            ? row.stageNames.filter(Boolean)
            : Array.isArray(existingRow?.stageNames)
              ? existingRow.stageNames
              : [],
          unit: String(row?.unit ?? existingRow?.unit ?? "").trim(),
          status: String(row?.status || "open").toLowerCase(),
          photoIds,
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

  parseSiteIdsQuery = (raw) => {
    if (raw == null || raw === "") return [];
    return String(raw)
      .split(",")
      .map((id) => Number(String(id).trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
  };

  getAllIssuesHistory = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const siteIds = this.parseSiteIdsQuery(req.query.siteIds);

      const where = siteIds.length > 0 ? { siteId: { in: siteIds } } : {};

      const records = await prisma.dailyIssueUpdate.findMany({
        where,
        include: {
          site: { select: { id: true, name: true } },
        },
        orderBy: [{ updatedAt: "desc" }, { date: "desc" }],
        take: limit,
      });

      const data = records.map((record) => ({
        ...record,
        siteName: record.site?.name || `Site #${record.siteId}`,
      }));

      return this.sendResponse(req, res, {
        message: "All daily issues history fetched successfully",
        status: 200,
        data,
      });
    } catch (error) {
      console.error("Error in get all daily issues history:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch all daily issues history",
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

  getAllSiteProgressHistory = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily updates",
          status: 403,
        });
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const siteIds = this.parseSiteIdsQuery(req.query.siteIds);

      const where = siteIds.length > 0 ? { siteId: { in: siteIds } } : {};

      const records = await prisma.dailySiteProgressUpdate.findMany({
        where,
        include: {
          site: { select: { id: true, name: true } },
        },
        orderBy: [{ updatedAt: "desc" }, { date: "desc" }],
        take: limit,
      });

      const data = records.map((record) => ({
        ...record,
        siteName: record.site?.name || `Site #${record.siteId}`,
      }));

      return this.sendResponse(req, res, {
        message: "All daily site progress history fetched successfully",
        status: 200,
        data,
      });
    } catch (error) {
      console.error("Error in get all daily site progress history:", error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch all daily site progress history",
        status: 500,
      });
    }
  };

  buildPhotoUrl = (req, photoId) => {
    const baseUrl = getApiBaseUrl(req);
    return `${baseUrl}/dailyUpdate/photos/file/${photoId}`;
  };

  mapPhotoRow = (req, row) => ({
    id: row.id,
    siteId: row.siteId,
    siteName: row.site?.name || null,
    date: row.date,
    category: row.category,
    caption: row.caption || "",
    issueId: row.issueId || null,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByName,
    createdAt: row.createdAt,
    url: this.buildPhotoUrl(req, row.id),
  });

  uploadPhotos = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message:
            "Only admin, supervisor, super admin, site engineer, and director can upload daily update photos",
        });
      }

      const siteId = Number(req.body?.siteId);
      const date = normalizeDateOnly(req.body?.date);
      const category = String(req.body?.category || "site_progress")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
      const caption = String(req.body?.caption || "").trim();
      const issueId = String(req.body?.issueId || "").trim() || null;

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }
      if (!date) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid date is required",
        });
      }
      if (date > getTodayUtcDateOnly()) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Future date is not allowed",
        });
      }

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Site not found",
        });
      }

      const incoming = req?.files?.photos || req?.files?.photo || req?.files?.files;
      const fileList = !incoming
        ? []
        : Array.isArray(incoming)
          ? incoming
          : [incoming];

      if (fileList.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "At least one photo/file is required",
        });
      }

      const allowedCategories = new Set([
        "delivery_slip",
        "damage_report",
        "site_progress",
        "other",
      ]);
      const normalizedCategory = allowedCategories.has(category)
        ? category
        : "site_progress";

      const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024; // 5MB
      const MAX_COMPRESSED_IMAGE_BYTES = 200 * 1024; // 200KB
      const created = [];
      const rejected = [];

      for (const file of fileList) {
        const mimeType = String(file?.mimetype || "application/octet-stream").toLowerCase();
        const isImage = mimeType.startsWith("image/");
        const isPdf = mimeType === "application/pdf";
        if (!isImage && !isPdf) {
          continue;
        }

        const buffer = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data || []);
        if (!buffer.length) continue;

        const originalName = String(file?.name || "daily-update-file")
          .replace(/[^\w.\-]+/g, "_")
          .slice(0, 120);

        if (buffer.length > MAX_ORIGINAL_BYTES) {
          rejected.push(`${originalName} exceeds 5MB`);
          continue;
        }

        if (isImage && buffer.length > MAX_COMPRESSED_IMAGE_BYTES) {
          rejected.push(
            `${originalName} must be compressed to 200KB or less before upload`,
          );
          continue;
        }

        const baseName = originalName.replace(/\.[^/.]+$/, "") || "daily-update-file";
        const fileName = isImage ? `${baseName}.webp` : originalName;
        const storedMime = isImage ? "image/webp" : mimeType;

        const row = await prisma.dailyUpdatePhoto.create({
          data: {
            siteId,
            date,
            category: normalizedCategory,
            caption: caption || null,
            issueId,
            fileName,
            mimeType: storedMime,
            size: Number(buffer.length || 0),
            data: buffer,
            uploadedBy: req.user?.id || null,
            uploadedByName: req.user?.name || null,
          },
        });
        created.push(this.mapPhotoRow(req, row));
      }

      if (created.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message:
            rejected[0] ||
            "No valid image/PDF files were uploaded (images max 5MB original, 200KB compressed)",
        });
      }

      return this.sendResponse(req, res, {
        status: 201,
        message: "Photos uploaded successfully",
        data: created,
      });
    } catch (error) {
      console.error("Error in upload daily update photos:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to upload photos",
        error: error.message,
      });
    }
  };

  getPhotosGallery = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily update photos",
        });
      }

      const rawLimit = Number(req.query?.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 100)
          : 48;

      const rows = await prisma.dailyUpdatePhoto.findMany({
        where: {
          mimeType: { startsWith: "image/" },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          siteId: true,
          date: true,
          category: true,
          caption: true,
          issueId: true,
          fileName: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          uploadedByName: true,
          createdAt: true,
          site: { select: { name: true } },
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Gallery photos fetched successfully",
        data: rows.map((row) => this.mapPhotoRow(req, row)),
      });
    } catch (error) {
      console.error("Error in get gallery photos:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch gallery photos",
      });
    }
  };

  getPhotosBySite = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily update photos",
        });
      }

      const siteId = Number(req.params.siteId);
      const rawLimit = Number(req.query?.limit);
      const wantAll = String(req.query?.all || "") === "1";
      const limit = wantAll
        ? undefined
        : Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 5000)
          : 48;

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }

      const rows = await prisma.dailyUpdatePhoto.findMany({
        where: { siteId },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        ...(limit ? { take: limit } : {}),
        select: {
          id: true,
          siteId: true,
          date: true,
          category: true,
          caption: true,
          issueId: true,
          fileName: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          uploadedByName: true,
          createdAt: true,
          site: { select: { name: true } },
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Site gallery photos fetched successfully",
        data: rows.map((row) => this.mapPhotoRow(req, row)),
      });
    } catch (error) {
      console.error("Error in get photos by site:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch site photos",
      });
    }
  };

  getPhotosBySiteDate = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message:
            "Only admin, supervisor, super admin, site engineer, and director can access daily update photos",
        });
      }

      const siteId = Number(req.params.siteId);
      // Only filter by date when the client explicitly sends one.
      // Do NOT default missing date to "today" (that broke the gallery).
      const hasDateQuery =
        req.query?.date !== undefined &&
        req.query?.date !== null &&
        String(req.query.date).trim() !== "";
      const date = hasDateQuery ? normalizeDateOnly(req.query.date) : null;
      const rawLimit = Number(req.query?.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 100)
          : date
            ? undefined
            : 24;

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }
      if (hasDateQuery && !date) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid date is required",
        });
      }

      const rows = await prisma.dailyUpdatePhoto.findMany({
        where: {
          siteId,
          ...(date ? { date } : {}),
        },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: limit } : {}),
        select: {
          id: true,
          siteId: true,
          date: true,
          category: true,
          caption: true,
          issueId: true,
          fileName: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          uploadedByName: true,
          createdAt: true,
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Daily update photos fetched successfully",
        data: rows.map((row) => this.mapPhotoRow(req, row)),
      });
    } catch (error) {
      console.error("Error in get daily update photos:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch photos",
      });
    }
  };

  getPhotoFile = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Access denied",
        });
      }

      const photoId = Number(req.params.id);
      if (!Number.isFinite(photoId) || photoId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid photo id",
        });
      }

      const row = await prisma.dailyUpdatePhoto.findUnique({
        where: { id: photoId },
      });
      if (!row?.data) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Photo not found",
        });
      }

      res.setHeader("Content-Type", row.mimeType || "image/webp");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${String(row.fileName || "photo").replace(/"/g, "")}"`,
      );
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(Buffer.from(row.data));
    } catch (error) {
      console.error("Error in get daily update photo file:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to retrieve photo",
      });
    }
  };

  updatePhotoCaption = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Access denied",
        });
      }

      const photoId = Number(req.params.id);
      if (!Number.isFinite(photoId) || photoId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid photo id",
        });
      }

      const caption = String(req.body?.caption ?? req.body?.note ?? "").trim();
      const existing = await prisma.dailyUpdatePhoto.findUnique({
        where: { id: photoId },
        select: {
          id: true,
          siteId: true,
          date: true,
          category: true,
          fileName: true,
          mimeType: true,
          size: true,
          uploadedBy: true,
          uploadedByName: true,
          createdAt: true,
        },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Photo not found",
        });
      }

      const updated = await prisma.dailyUpdatePhoto.update({
        where: { id: photoId },
        data: { caption: caption || null },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Note updated successfully",
        data: this.mapPhotoRow(req, updated),
      });
    } catch (error) {
      console.error("Error in update daily update photo caption:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to update note",
      });
    }
  };

  deletePhoto = async (req, res) => {
    try {
      if (!this.hasDailyUpdateAccess(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Access denied",
        });
      }

      const photoId = Number(req.params.id);
      if (!Number.isFinite(photoId) || photoId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid photo id",
        });
      }

      const existing = await prisma.dailyUpdatePhoto.findUnique({
        where: { id: photoId },
        select: { id: true },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Photo not found",
        });
      }

      await prisma.dailyUpdatePhoto.delete({ where: { id: photoId } });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Photo deleted successfully",
        data: { id: photoId },
      });
    } catch (error) {
      console.error("Error in delete daily update photo:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to delete photo",
      });
    }
  };
}

module.exports = DailyUpdate;
