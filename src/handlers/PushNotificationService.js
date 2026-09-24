const { Role } = require("@prisma/client");
const Response = require("./Response");
const webpush = require("web-push");
const { emitToUsers } = require("../socket");

const prisma = require("../lib/prisma");

class PushNotificationService {
  constructor() {
    this.response = new Response();
    this.vapidConfigured = false;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      const vapidSubject = process.env.VAPID_SUBJECT || "mailto:support@sb-procurement.com";
      webpush.setVapidDetails(
        vapidSubject,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      this.vapidConfigured = true;
      // console.log(`[Notification][Push] VAPID configured subject=${vapidSubject}`);
    } else {
      // console.log("[Notification][Push] VAPID not configured (missing keys)");
    }
  }

  getFrontendAppUrl = () =>
    String(process.env.FRONTEND_APP_URL || "https://sb-procurement-fe-v2.vercel.app").replace(/\/+$/, "");

  sendPushToUsers = async (userIds = [], payload = {}) => {
    if (!this.vapidConfigured || !Array.isArray(userIds) || userIds.length === 0) {
      return;
    }
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: { in: userIds } },
      select: { endpoint: true, p256dh: true, auth: true, userId: true },
    });
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              ...payload,
              appUrl: payload?.appUrl || this.getFrontendAppUrl(),
            })
          );
          // success
        } catch (error) {
          const statusCode = error?.statusCode;
          console.error(
            `[Notification][Push] failed user=${sub.userId} endpoint=${sub.endpoint.slice(
              0,
              60
            )}... status=${statusCode || "unknown"} message=${error?.message || "Unknown error"}`
          );
          // Apple web push can return 403 for invalid/expired subscriptions.
          // Clean these up so users can resubscribe with a fresh endpoint.
          if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
            await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
            // stale subscription removed
          }
        }
      })
    );
  };

  logNotificationFlow = ({ event, senderId, recipientIds = [] }) => {};

  resolveActionFromRequestPayload = (
    payload = {},
    fallbackAction = "updated",
    approvalRole = ""
  ) => {
    const explicit = String(payload?.eventType || payload?.action || fallbackAction || "updated")
      .toLowerCase()
      .trim();
    if (explicit && explicit !== "updated") return explicit;
    const normalizedApprovalRole = String(approvalRole || "")
      .toLowerCase()
      .trim();

    const status = String(payload?.status || "").toLowerCase();
    const stages = Array.isArray(payload?.stages) ? payload.stages : [];
    const qaStatus = String(
      stages.find((stage) => String(stage?.stageName || "").toUpperCase() === "QA")?.status || ""
    ).toLowerCase();
    const accountStatus = String(
      stages.find((stage) => String(stage?.stageName || "").toUpperCase() === "ACCOUNT")?.status || ""
    ).toLowerCase();
    const releasedQty = Number(payload?.releasedQty ?? payload?.released_qty ?? 0);
    const receivedQty = Number(payload?.receivedQty ?? payload?.received_qty ?? 0);

    // If request is currently pending/in-progress, avoid approved-style actions.
    if (status === "pending") {
      return "pending";
    }
    if (status === "in_progress" || status === "in-progress") {
      return "updated";
    }

    if (status === "rejected" || qaStatus === "rejected" || accountStatus === "rejected") {
      return "rejected";
    }
    // Use current approval role hint from caller when explicit action is absent.
    if (
      normalizedApprovalRole === "account" ||
      normalizedApprovalRole === "accounts"
    ) {
      return "account_approved";
    }
    if (normalizedApprovalRole === "qa") return "qa_approved";
    // Account approval must take precedence over QA once both are approved.
    if (accountStatus === "approved") return "account_approved";
    if (qaStatus === "approved") return "qa_approved";
    if (releasedQty > 0) return "released";
    if (receivedQty > 0 || status === "approved" || status === "completed") return "completed";
    return "updated";
  };

  buildMaterialRequestMessage = ({
    action,
    role,
    actorName,
    approvalRole,
    materialName,
    requestId,
    siteName,
    releasedQty,
    receivedQty,
  }) => {
    const actorRole = String(role || "User")
      .replace(/_/g, " ")
      .toLowerCase();
    const actorRoleLabel = actorRole
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
    const actorIdentity = `${actorRoleLabel} (${actorName || "User"})`;
    const requestLabel = requestId ? `MR-${requestId}` : "material request";
    const target = materialName ? `"${materialName}"` : "material";
    const siteText = siteName ? ` at ${siteName}` : "";
    const releasedQtyText = Number(releasedQty) > 0 ? ` (${Number(releasedQty)})` : "";
    const receivedQtyText = Number(receivedQty) > 0 ? ` (${Number(receivedQty)})` : "";
    const approvalRoleLabel =
      String(
        approvalRole ||
          (action === "qa_approved"
            ? "QA"
            : action === "account_approved"
            ? "Account"
            : "Approval")
      )
        .replace(/_/g, " ")
        .trim();

    const titleMap = {
      created: siteName || "Material Request",
      pending: siteName || "Material Request",
      qa_approved: siteName || "Material Request",
      account_approved: siteName || "Material Request",
      approved: siteName || "Material Request",
      released: siteName || "Material Request",
      completed: siteName || "Material Request",
      rejected: siteName || "Material Request",
      deleted: siteName || "Material Request",
      updated: siteName || "Material Request",
    };

    const actionTextMap = {
      created: `${requestLabel} was created by ${actorIdentity}.`,
      pending: `The ${approvalRoleLabel} step for ${requestLabel} is pending by ${actorIdentity}.`,
      qa_approved: `The ${approvalRoleLabel} step for ${requestLabel} was approved by ${actorIdentity}.`,
      account_approved: `The ${approvalRoleLabel} step for ${requestLabel} was approved by ${actorIdentity}.`,
      approved: `The ${approvalRoleLabel} step for ${requestLabel} was approved by ${actorIdentity}.`,
      released: `${actorIdentity} released quantity${releasedQtyText} for ${requestLabel}${siteText}.`,
      completed: `${actorIdentity} received quantity${receivedQtyText} and completed ${requestLabel}${siteText}.`,
      rejected: `The ${approvalRoleLabel} step for ${requestLabel} was rejected by ${actorIdentity}.`,
      deleted: `The ${approvalRoleLabel} step for ${requestLabel} was deleted by ${actorIdentity}.`,
      updated: `The ${approvalRoleLabel} step for ${requestLabel} was updated by ${actorIdentity}.`,
    };
    return {
      title: titleMap[action] || titleMap.updated,
      body: actionTextMap[action] || actionTextMap.updated,
      type: "MaterialRequest",
    };
  };

  buildSiteActivityMessage = ({
    action,
    actorRole,
    actorName,
    siteName,
    status,
    stage,
    productId,
    qty,
  }) => {
    const roleLabel = String(actorRole || "user")
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
    const actorLabel = `${actorName || "User"} (${roleLabel})`;
    const siteText = siteName || "site";
    const normalizedAction = String(action || "updated").toLowerCase();
    const normalizedStatus = String(status || "")
      .toLowerCase()
      .replace(/_/g, "-")
      .trim();
    const statusLabel =
      normalizedStatus === "data uploading" || normalizedStatus === "pending"
        ? "Data Uploading"
        : normalizedStatus === "in-progress" || normalizedStatus === "in progress"
        ? "In Progress"
        : normalizedStatus === "completed"
        ? "Completed"
        : status || "Updated";
    const stageText = stage ? ` stage "${stage}"` : "";
    const materialText = productId ? ` (product #${productId}${qty ? `, qty ${qty}` : ""})` : "";
    const actionMap = {
      created: `${actorLabel} created ${siteText}${stageText}${materialText}.`,
      updated: `${actorLabel} updated ${siteText}${stageText}${materialText}.`,
      update: `${actorLabel} updated ${siteText}${stageText}${materialText}.`,
      status_updated: `User: ${actorName || "User"} | Role: ${roleLabel} | Site Status: ${statusLabel}.`,
      delete: `${actorLabel} deleted site "${siteText}"${stageText}${materialText}.`,
      deleted: `${actorLabel} deleted site "${siteText}"${stageText}${materialText}.`,
      stage_added: `${actorLabel} added material to ${siteText}${stageText}${materialText}.`,
      stage_updated: `${actorLabel} updated ${siteText}${stageText}${materialText}.`,
      stage_deleted: `${actorLabel} deleted ${siteText}${stageText}${materialText}.`,
      stage_status_updated: `${actorLabel} changed${stageText} status to "${statusLabel}" on ${siteText}.`,
    };
    return {
      title:
        normalizedAction === "stage_status_updated"
          ? `Stage Status Updated - ${siteText}`
          : siteText,
      body: actionMap[normalizedAction] || actionMap.updated,
      type: "SiteActivity",
    };
  };

  createNotificationPayloadForUsers = ({ recipientIds = [], title, body, type, data }) => {
    const now = Date.now();
    return [...new Set(recipientIds)]
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => ({
        userId: id,
        title,
        body,
        type: type || "Text",
        data: data || {},
        _dedupeKey: `${id}|${type}|${title}|${body}|${JSON.stringify(data || {})}|${Math.floor(now / 60000)}`,
      }));
  };

  dispatchNotifications = async ({
    event,
    senderId,
    recipientIds = [],
    title,
    body,
    type = "Text",
    data = {},
    includeSender = false,
  }) => {
    const uniqueRecipientIds = [...new Set(recipientIds)]
      .map((id) => Number(id))
      .filter((id) => {
        if (!Number.isFinite(id) || id <= 0) return false;
        if (includeSender) return true;
        return id !== Number(senderId);
      });

    this.logNotificationFlow({ event, senderId, recipientIds: uniqueRecipientIds });
    if (uniqueRecipientIds.length === 0) return { totalRecipients: 0, createdCount: 0 };

    const rows = this.createNotificationPayloadForUsers({
      recipientIds: uniqueRecipientIds,
      title,
      body,
      type,
      data,
    });

    const dedupeSince = new Date(Date.now() - 60000);
    const existing = await prisma.notification.findMany({
      where: {
        userId: { in: uniqueRecipientIds },
        type,
        title,
        body,
        createdAt: { gte: dedupeSince },
      },
      select: { userId: true },
    });
    const existingUsers = new Set(existing.map((row) => Number(row.userId)));
    const filteredRows = rows.filter((row) => !existingUsers.has(row.userId));

    if (filteredRows.length > 0) {
      await prisma.notification.createMany({
        data: filteredRows.map(({ _dedupeKey, ...row }) => row),
      });
    }

    await this.sendPushToUsers(uniqueRecipientIds, {
      title,
      body,
      type,
      icon: "/logo.png",
      data,
    });

    const realtimePayload = {
      title,
      body,
      type,
      data,
      senderId,
      recipientIds: uniqueRecipientIds,
      createdAt: new Date().toISOString(),
    };

    // Room-targeted emit (preferred)
    emitToUsers(uniqueRecipientIds, "notification:new", realtimePayload);

    // Broadcast fallback so clients still receive even if a user room join was missed.
    try {
      const { emitBroadcast } = require("../socket");
      emitBroadcast("notification:new", realtimePayload);
    } catch (error) {
      console.error(
        "[Notification][Socket] broadcast fallback failed:",
        error?.message || error
      );
    }

    console.log("[Notification][Socket] emitted notification:new", {
      event,
      type,
      recipientIds: uniqueRecipientIds,
      senderId,
    });

    return {
      totalRecipients: uniqueRecipientIds.length,
      createdCount: filteredRows.length,
      duplicateSkipped: uniqueRecipientIds.length - filteredRows.length,
    };
  };

  getSiteRelatedRecipientIds = async (siteId, senderId) => {
    const parsedSiteId = Number(siteId);
    if (!Number.isFinite(parsedSiteId) || parsedSiteId <= 0) return [];

    const [siteSupervisors, sitePurchasers, siteSeniorEngineers, roleUsers] = await Promise.all([
      prisma.siteSupervisor.findMany({ where: { siteId: parsedSiteId }, select: { userId: true } }),
      prisma.sitePurchaser.findMany({ where: { siteId: parsedSiteId }, select: { userId: true } }),
      prisma.siteSeniorEngineer.findMany({ where: { siteId: parsedSiteId }, select: { userId: true } }),
      prisma.user.findMany({
        where: {
          role: { in: [Role.QA, Role.ACCOUNT, Role.ADMIN, Role.SUPER_ADMIN, Role.DIRECTOR] },
        },
        select: { id: true },
      }),
    ]);

    const recipientIds = new Set([
      ...siteSupervisors.map((u) => u.userId),
      ...sitePurchasers.map((u) => u.userId),
      ...siteSeniorEngineers.map((u) => u.userId),
      ...roleUsers.map((u) => u.id),
    ]);

    recipientIds.delete(Number(senderId));
    return Array.from(recipientIds).filter((id) => Number.isFinite(id) && id > 0);
  };

  sendNotificationToUserUploadFile = async (req, res) => {
    try {
      const { userId, payload } = req.body;
      const senderId = Number(userId);
      const siteId = Number(payload?.siteId || payload?.site?.id);
      const siteRecipientIds = await this.getSiteRelatedRecipientIds(siteId, senderId);
      const recipientIds =
        siteRecipientIds.length > 0
          ? siteRecipientIds
          : (
              await prisma.user.findMany({
                where: { id: { not: senderId } },
                select: { id: true },
              })
            ).map((u) => u.id);
      const dispatch = await this.dispatchNotifications({
        event: "UPLOAD_FILE",
        senderId,
        recipientIds,
        title: payload?.title || "Notification",
        body: payload?.body || "",
        type: payload?.type || "Text",
        data: payload?.data || {},
      });
      return res.status(200).json({ message: "Notification saved", totalRecipients: dispatch.totalRecipients });
    } catch (error) {
      return res.status(500).json({ message: "Error sending notification", data: error.message });
    }
  };

  sendNotificationOnSendMessage = async (req, res) => {
    try {
      const { userId, message } = req.body;
      const senderId = Number(userId);
      const group = await prisma.chatGroup.findUnique({
        where: { id: Number(message?.groupId) },
        include: { members: true },
      });
      if (!group) return res.status(404).json({ message: "Group not found" });
      const recipients = group.members.filter((m) => m.userId !== senderId);
      this.logNotificationFlow({
        event: "CHAT_MESSAGE",
        senderId,
        recipientIds: recipients.map((m) => m.userId),
      });
      await prisma.notification.createMany({
        data: recipients.map((m) => ({
          userId: m.userId,
          title: `${message?.sender?.name || "User"} - ${group.name}`,
          body: message?.content || "",
          type: message?.type || "TEXT",
          data: { groupId: group.id },
        })),
      });
      await this.sendPushToUsers(
        recipients.map((m) => m.userId),
        {
          title: `${message?.sender?.name || "User"} - ${group.name}`,
          body: message?.content || "",
          icon: "/logo.png",
          data: { groupId: group.id },
        }
      );
      return res.status(200).json({ message: "Notification sent", totalRecipients: recipients.length, failed: 0 });
    } catch (error) {
      return res.status(500).json({ message: "Error sending notification", data: error.message });
    }
  };

  sendNotificationToUserCreateSite = async (req, res) => {
    try {
      const senderId = Number(req.body.userId);
      const sender = await prisma.user.findUnique({ where: { id: senderId } });
      if (!sender) return res.status(404).json({ message: "Sender not found" });
      const site = req.body.payload?.site || req.body.payload;
      const siteId = Number(site?.id);

      const action = String(req.body.action || req.body.payload?.action || "updated").toLowerCase();
      const recipientIds = await this.getSiteRelatedRecipientIds(siteId, senderId);
      const message = this.buildSiteActivityMessage({
        action,
        actorRole: sender.role,
        actorName: sender.name,
        siteName: site?.name,
        status: site?.status,
      });
      const dispatch = await this.dispatchNotifications({
        event: `SITE_${action.toUpperCase()}`,
        senderId,
        recipientIds,
        title: message.title,
        body: message.body,
        type: message.type,
        data: { ...(site || {}), action, siteId },
      });
      return res.status(200).json({ message: "Notification sent and saved to DB", totalRecipients: dispatch.totalRecipients, failed: 0 });
    } catch (error) {
      return res.status(500).json({ message: "Error sending notification", error: error.message });
    }
  };

  saveSubscription = async (req, res) => {
    try {
      const { subscription, userId } = req.body;
      const resolvedUserId = Number(req.user?.id || userId);
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth || !resolvedUserId) {
        return this.response.sendResponse(req, res, { message: "Invalid subscription details", status: 400 });
      }
      await prisma.pushSubscription.upsert({
        where: { endpoint: subscription.endpoint },
        create: {
          userId: resolvedUserId,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
        update: {
          userId: resolvedUserId,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      });
      return this.response.sendResponse(req, res, { message: "Subscription saved successfully", status: 200 });
    } catch (error) {
      return this.response.sendResponse(req, res, { message: "Error saving subscription", status: 500, data: error.message });
    }
  };

  checkSubscription = async (req, res) => {
    try {
      const endpoint = String(req.body?.endpoint || "").trim();
      const userId = Number(req.user?.id || req.body?.userId);
      if (!endpoint || !userId) {
        return this.response.sendResponse(req, res, {
          message: "Invalid subscription details",
          status: 400,
          data: { valid: false },
        });
      }
      const existing = await prisma.pushSubscription.findFirst({
        where: { endpoint, userId },
        select: { id: true },
      });
      return this.response.sendResponse(req, res, {
        message: existing ? "Subscription is active" : "Subscription is missing",
        status: 200,
        data: { valid: Boolean(existing) },
      });
    } catch (error) {
      return this.response.sendResponse(req, res, {
        message: "Error checking subscription",
        status: 500,
        data: { valid: false },
      });
    }
  };

  clearSubscription = async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ message: "User ID is required." });
      const result = await prisma.pushSubscription.deleteMany({ where: { userId: Number(userId) } });
      return res.status(200).json({ message: "Notifications cleared successfully.", deleted: result.count });
    } catch (error) {
      return res.status(500).json({ message: "Error clearing notifications." });
    }
  };

  getNotificationsByUserId = async (req, res) => {
    const userId = Number(req.params.userId);
    if (Number.isNaN(userId)) return res.status(400).json({ message: "Invalid user ID." });
    try {
      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json({ notifications });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch notifications.", error: error.message });
    }
  };

  sendNotificationOnMaterialRequest = async (req, res) => {
    try {
      const senderId = Number(req.body.userId);
      const sender = await prisma.user.findUnique({
        where: { id: senderId },
        select: { id: true, name: true, role: true },
      });
      const role = String(sender?.role || req.body.role || "").toUpperCase();
      const payload = req.body.payload || {};
      const material = await prisma.product.findUnique({ where: { id: Number(payload.productId) } });
      const site = await prisma.site.findUnique({ where: { id: Number(payload?.siteId) } });
      const action = this.resolveActionFromRequestPayload(
        payload,
        req.body?.action || "updated",
        req.body?.approvalRole || payload?.approvalRole
      );

      const selectedRecipientIds = new Set();
      const addIfValid = (id) => {
        const parsed = Number(id);
        if (Number.isFinite(parsed) && parsed > 0 && parsed !== senderId) {
          selectedRecipientIds.add(parsed);
        }
      };
      const addUsersByRoles = async (roles = []) => {
        const roleList = (Array.isArray(roles) ? roles : [])
          .map((r) => String(r || "").toUpperCase())
          .filter(Boolean);
        if (!roleList.length) return;
        const users = await prisma.user.findMany({
          where: { role: { in: roleList } },
          select: { id: true },
        });
        users.forEach((user) => addIfValid(user.id));
      };

      // Stage-based payload support
      if (Array.isArray(payload?.stages)) {
        payload.stages.forEach((stage) => addIfValid(stage?.userId || stage?.user_id));
      }

      // Fallback for admin-created requests when explicit users are not passed
      if (
        selectedRecipientIds.size === 0 &&
        [Role.ADMIN, Role.SUPER_ADMIN, Role.DIRECTOR].includes(role)
      ) {
        const siteId = Number(payload?.siteId);
        if (Number.isFinite(siteId) && siteId > 0) {
          const [siteSupervisors, sitePurchasers] = await Promise.all([
            prisma.siteSupervisor.findMany({ where: { siteId }, select: { userId: true } }),
            prisma.sitePurchaser.findMany({ where: { siteId }, select: { userId: true } }),
          ]);
          siteSupervisors.forEach((u) => addIfValid(u.userId));
          sitePurchasers.forEach((u) => addIfValid(u.userId));
        }
      }

      // Stage-wise routing (strict role targeting):
      // - created/pending/updated: QA + ADMIN + SUPER_ADMIN
      // - qa_approved: ACCOUNT
      // - account_approved: PURCHASER
      // Other actions keep existing broad fallback behavior.
      // NOTE: Clear previously collected stage user IDs for these explicit actions
      // so Purchaser doesn't receive created/qa_approved events.
      if (["created", "pending", "updated"].includes(action)) {
        selectedRecipientIds.clear();
        await addUsersByRoles([Role.QA, Role.ADMIN, Role.SUPER_ADMIN]);
      } else if (action === "qa_approved") {
        selectedRecipientIds.clear();
        await addUsersByRoles([Role.ACCOUNT]);
      } else if (action === "account_approved") {
        selectedRecipientIds.clear();
        await addUsersByRoles([Role.PURCHASER]);
      } else if (action === "released") {
        selectedRecipientIds.clear();
        await addUsersByRoles([Role.ACCOUNT]);
        const siteId = Number(payload?.siteId);
        if (Number.isFinite(siteId) && siteId > 0) {
          const siteSupervisors = await prisma.siteSupervisor.findMany({
            where: { siteId },
            select: { userId: true },
          });
          siteSupervisors.forEach((u) => addIfValid(u.userId));
        }
      } else {
        const siteRelatedRecipientIds = await this.getSiteRelatedRecipientIds(payload?.siteId, senderId);
        siteRelatedRecipientIds.forEach((id) => selectedRecipientIds.add(id));
      }

      const recipientIds = Array.from(selectedRecipientIds);
      if (recipientIds.length === 0) {
        return res.status(200).json({
          message: "No selected recipients found for material request notification",
          totalRecipients: 0,
          failed: 0,
        });
      }
      const message = this.buildMaterialRequestMessage({
        action,
        role,
        actorName: sender?.name,
        approvalRole:
          req.body?.approvalRole ||
          payload?.approvalRole ||
          payload?.stageName ||
          payload?.currentStage ||
          (action === "qa_approved"
            ? "QA"
            : action === "account_approved"
            ? "Account"
            : "Approval"),
        materialName: material?.name,
        requestId: payload?.siteRequestId,
        siteName: site?.name,
        releasedQty: payload?.releasedQty ?? payload?.released_qty,
        receivedQty: payload?.receivedQty ?? payload?.received_qty,
      });
      const dispatch = await this.dispatchNotifications({
        event: `MATERIAL_REQUEST_${action.toUpperCase()}`,
        senderId,
        recipientIds,
        title: message.title,
        body: message.body,
        type: message.type,
        data: { ...payload, action, siteName: site?.name, materialName: material?.name },
      });
      return res.status(200).json({ message: "Material request notifications sent", totalRecipients: dispatch.totalRecipients, failed: 0 });
    } catch (error) {
      return res.status(500).json({ message: "Failed to send material request notifications", error: error.message });
    }
  };

  sendNotificationOnStageAdd = async (req, res) => {
    try {
      const { siteId, stage, productId, qty, userId, eventType, status } = req.body;
      const normalizedEventType = String(eventType || "")
        .toLowerCase()
        .trim();
      const normalizedStage = String(stage || "")
        .toLowerCase()
        .trim();
      const allowedStageEvents = new Set([
        "stage_added",
        "stage_updated",
        "stage_deleted",
        "stage_status_updated",
      ]);

      // Do not notify for QA data updates.
      if (
        normalizedStage === "qa" ||
        normalizedStage === "quality assurance" ||
        normalizedEventType === "qa_data_added" ||
        normalizedEventType === "qa_updated" ||
        normalizedEventType === "qa_data_updated"
      ) {
        return res.status(200).json({
          message: "QA data notification skipped",
          totalRecipients: 0,
          failed: 0,
          skipped: true,
        });
      }

      // Only notify for explicit stage add/edit/delete/status actions.
      if (!allowedStageEvents.has(normalizedEventType)) {
        return res.status(200).json({
          message: "Notification skipped: only stage add/edit/delete/status events are allowed",
          totalRecipients: 0,
          failed: 0,
          skipped: true,
        });
      }

      const senderId = Number(userId);
      const sender = await prisma.user.findUnique({ where: { id: senderId } });
      const site = await prisma.site.findUnique({ where: { id: Number(siteId) } });
      if (!sender || !site) return res.status(404).json({ message: "Sender or site not found" });

      const recipientIds = await this.getSiteRelatedRecipientIds(siteId, senderId);
      const message = this.buildSiteActivityMessage({
        action: normalizedEventType,
        actorRole: sender.role,
        actorName: sender.name,
        siteName: site.name,
        stage,
        status,
        productId,
        qty,
      });
      const dispatch = await this.dispatchNotifications({
        event: `STAGE_${String(normalizedEventType || "updated").toUpperCase()}`,
        senderId,
        recipientIds,
        title: message.title,
        body: message.body,
        type: "Stage",
        data: {
          siteId,
          stage,
          status,
          productId,
          qty,
          eventType: normalizedEventType,
        },
      });
      return res.status(200).json({ message: "Stage notification sent", totalRecipients: dispatch.totalRecipients });
    } catch (error) {
      return res.status(500).json({ message: "Error sending stage notification", error: error.message });
    }
  };

  getLengthNotificationByUserId = async (req, res) => {
    const userId = Number(req.params.userId);
    if (Number.isNaN(userId)) return res.status(400).json({ message: "Invalid user ID." });
    try {
      const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });
      return res.status(200).json({ unreadCount });
    } catch (error) {
      return res.status(500).json({ message: "Failed to fetch notifications.", error: error.message });
    }
  };

  getLastNotifications = async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      return res.status(200).json({ message: "Last 5 notifications fetched successfully", data: notifications, status: 200 });
    } catch (error) {
      return res.status(500).json({ message: "Error fetching notifications", error: error.message });
    }
  };

  markNotificationAsRead = async (req, res) => {
    try {
      const notificationId = Number(req.params.notificationId);
      const userId = Number(req.body.userId);
      const updated = await prisma.notification.updateMany({
        where: { id: notificationId, userId },
        data: { isRead: true },
      });
      if (updated.count === 0) {
        return res.status(404).json({ message: "Notification not found or doesn't belong to this user" });
      }
      return res.status(200).json({ message: "Notification marked as read successfully", status: 200 });
    } catch (error) {
      return res.status(500).json({ message: "Error marking notification as read", error: error.message });
    }
  };

  markAllNotificationsAsRead = async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      });
      return res.status(200).json({ message: `${result.count} notifications marked as read successfully`, updatedCount: result.count, status: 200 });
    } catch (error) {
      return res.status(500).json({ message: "Error marking all notifications as read", error: error.message });
    }
  };

  clearAllNotifications = async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const result = await prisma.notification.deleteMany({ where: { userId } });
      return res.status(200).json({ message: `${result.count} notifications cleared successfully`, deletedCount: result.count, status: 200 });
    } catch (error) {
      return res.status(500).json({ message: "Error clearing all notifications", error: error.message });
    }
  };
}

module.exports = PushNotificationService;
