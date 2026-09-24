const { Role } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { canUserAccessSite } = require("../lib/siteAccess");
const Response = require("./Response");
const PushNotificationService = require("./PushNotificationService");

const pushNotificationService = new PushNotificationService();

const getIds = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((i) => Number(i.userId ?? i.ids ?? i.id))
    .filter((id) => Number.isFinite(id));

const normalizePurchasers = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      const userId = Number(item?.userId ?? item?.ids ?? item?.id);
      if (!Number.isFinite(userId)) return null;
      const productIds = (Array.isArray(item?.productIds) ? item.productIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id));
      return {
        userId,
        status: String(item?.status || "active").toLowerCase(),
        allProducts: Boolean(item?.allProducts),
        productIds,
      };
    })
    .filter(Boolean);

const toDateOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const uniqueUserIds = (ids = []) =>
  [...new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];

const formatSiteStatusLabel = (status) => {
  const normalized = String(status || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .trim();
  if (normalized === "pending" || normalized === "data uploading") return "Data Uploading";
  if (normalized === "in-progress" || normalized === "in progress") return "In Progress";
  if (normalized === "completed") return "Completed";
  return status || "Updated";
};

const siteAssigneesInclude = {
  supervisors: {
    include: { user: { select: { id: true, name: true, role: true } } },
  },
  purchasers: {
    include: { user: { select: { id: true, name: true, role: true } } },
  },
  seniorEngineers: {
    include: { user: { select: { id: true, name: true, role: true } } },
  },
};

class Site extends Response {
  getAssignableUsers = async (req, res) => {
    try {
      const requestingRole = req?.user?.role;

      if (
        !requestingRole ||
        ![Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR].includes(requestingRole)
      ) {
        return this.sendResponse(req, res, {
          message: "Unauthorized to fetch site assignees",
          status: 403,
        });
      }

      const users = await prisma.user.findMany({
        where: {
          role: { in: [Role.SUPERVISOR, Role.PURCHASER, Role.SR_ENGINEER] },
        },
        select: {
          id: true,
          name: true,
          role: true,
          status: true,
          alreadyAssigned: true,
          purchaserAllProducts: true,
          purchaserProducts: {
            select: { productId: true, product: { select: { name: true } } },
          },
          _count: {
            select: {
              siteSupervisors: true,
              sitePurchasers: true,
              siteSeniorEngineers: true,
            },
          },
        },
        orderBy: { name: "asc" },
      });

      return this.sendResponse(req, res, {
        message: "Site assignees fetched successfully",
        status: 200,
        data: users.map((u) => ({
          ...u,
          role: String(u.role).toLowerCase(),
          productIds: u.purchaserProducts?.map((p) => p.productId) || [],
          productNames: u.purchaserProducts?.map((p) => p.product?.name).filter(Boolean) || [],
          assignedSiteCount:
            Number(u?._count?.siteSupervisors || 0) +
            Number(u?._count?.sitePurchasers || 0) +
            Number(u?._count?.siteSeniorEngineers || 0),
        })),
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to fetch site assignees",
        status: 500,
        error: error.message,
      });
    }
  };

  create = async (req, res) => {
    try {
      const { name, address, client_name, city, province, plot_size, status } = req.body;
      const supervisorIds = getIds(req.body.supervisors);
      const purchaserRows = normalizePurchasers(req.body.purchasers);
      const seniorEngineerIds = getIds(req.body.seniorEngineers);

      const requestingUser = await prisma.user.findUnique({
        where: { id: req.user?.id },
      });
      if (!requestingUser || ![Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR].includes(requestingUser.role)) {
        return this.sendResponse(req, res, {
          message: "Only admins or directors can create sites",
          status: 403,
        });
      }

      const site = await prisma.site.create({
        data: {
          name,
          address,
          client_name,
          city,
          province,
          plot_size,
          status,
          locationUrl: req.body.locationUrl ?? req.body.location_url ?? null,
          coveredArea: req.body.coveredArea ?? req.body.covered_area ?? null,
          marketingPersonName:
            req.body.marketingPersonName ?? req.body.marketing_person_name ?? null,
          marketingPersonPhone:
            req.body.marketingPersonPhone ?? req.body.marketing_person_phone ?? null,
          startDate: toDateOrNull(req.body.startDate ?? req.body.start_date),
          endDate: toDateOrNull(req.body.endDate ?? req.body.end_date),
          updated_by: requestingUser.id,
          supervisors: {
            create: supervisorIds.map((userId) => ({ userId })),
          },
          purchasers: { create: purchaserRows },
          seniorEngineers: {
            create: seniorEngineerIds.map((userId) => ({ userId })),
          },
        },
        include: siteAssigneesInclude,
      });

      const group = await prisma.chatGroup.create({
        data: { name: site.name, createdById: requestingUser.id },
      });

      const userIds = new Set([
        ...supervisorIds,
        ...purchaserRows.map((p) => p.userId),
        ...seniorEngineerIds,
        requestingUser.id,
      ]);
      if (requestingUser.role === Role.ADMIN || requestingUser.role === Role.SUPER_ADMIN) {
        const directors = await prisma.user.findMany({
          where: { role: Role.DIRECTOR },
          select: { id: true },
        });
        directors.forEach((d) => userIds.add(d.id));
      } else if (requestingUser.role === Role.DIRECTOR) {
        const admins = await prisma.user.findMany({
          where: { role: { in: [Role.SUPER_ADMIN, Role.ADMIN] } },
          select: { id: true },
        });
        admins.forEach((a) => userIds.add(a.id));
      }

      await prisma.chatMember.createMany({
        data: Array.from(userIds).map((userId) => ({ userId, groupId: group.id })),
        skipDuplicates: true,
      });

      const relatedUserIds = await pushNotificationService.getSiteRelatedRecipientIds(
        site.id,
        requestingUser.id
      );
      const createRecipients = uniqueUserIds([...relatedUserIds, requestingUser.id]);
      if (createRecipients.length) {
        await pushNotificationService.dispatchNotifications({
          event: "SITE_CREATED",
          senderId: requestingUser.id,
          recipientIds: createRecipients,
          title: site.name,
          body: `New site '${site.name}' is created by ${requestingUser.name}.`,
          type: "SiteActivity",
          data: { siteId: site.id, action: "created", siteName: site.name },
        });
      }

      return this.sendResponse(req, res, {
        message: "Site and group created successfully",
        status: 201,
        data: { site, groupId: group.id },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Something went wrong while creating site and group",
        status: 500,
        error: error.message,
      });
    }
  };

  getAll = async (req, res) => {
    try {
      const userId = req?.user?.id;
      const userRole = req?.user?.role;
      const allSites = await prisma.site.findMany({
        orderBy: { created_at: "desc" },
        include: siteAssigneesInclude,
      });

      const filteredSites = allSites.filter((site) => {
        if (userRole === Role.SUPERVISOR) {
          return site.supervisors.some((s) => s.userId === userId);
        }
        if (userRole === Role.PURCHASER) {
          return site.purchasers.some((p) => p.userId === userId);
        }
        if (userRole === Role.SR_ENGINEER) {
          return site.seniorEngineers.some((p) => p.userId === userId);
        }
        return true;
      });

      return this.sendResponse(req, res, {
        message: "Sites fetched successfully",
        status: 200,
        data: filteredSites,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to fetch sites",
        status: 500,
      });
    }
  };

  getById = async (req, res) => {
    try {
      const id = Number(req.params.id);
      const site = await prisma.site.findUnique({
        where: { id },
        include: siteAssigneesInclude,
      });
      if (!site) {
        return this.sendResponse(req, res, { message: "Site not found", status: 404 });
      }
      const allowed = await canUserAccessSite({
        userId: req?.user?.id,
        role: req?.user?.role,
        siteId: id,
      });
      if (!allowed) {
        return this.sendResponse(req, res, {
          message: "You do not have access to this site",
          status: 403,
        });
      }
      return this.sendResponse(req, res, {
        message: "Site fetched successfully",
        status: 200,
        data: site,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to fetch site",
        status: 500,
      });
    }
  };

  update = async (req, res) => {
    try {
      const siteId = Number(req.params.id);
      const userId = req?.user?.id;
      const userRole = req?.user?.role;
      const existingSite = await prisma.site.findUnique({
        where: { id: siteId },
        include: siteAssigneesInclude,
      });

      if (!existingSite) {
        return this.sendResponse(req, res, { message: "Site not found", status: 404 });
      }
      const actingUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, role: true },
      });
      const previousRelatedUserIds = uniqueUserIds([
        ...(existingSite?.supervisors || []).map((s) => s.userId),
        ...(existingSite?.purchasers || []).map((p) => p.userId),
        ...(existingSite?.seniorEngineers || []).map((s) => s.userId),
      ]);

      if (userRole !== Role.ADMIN && userRole !== Role.SUPER_ADMIN) {
        const isLinked = await prisma.site.findFirst({
          where: {
            id: siteId,
            OR: [
              { supervisors: { some: { userId } } },
              { purchasers: { some: { userId } } },
              { seniorEngineers: { some: { userId } } },
            ],
          },
        });
        if (!isLinked) {
          return this.sendResponse(req, res, {
            message: "Unauthorized to update this site",
            status: 403,
          });
        }
        const updatedSite = await prisma.site.update({
          where: { id: siteId },
          data: { status: req.body.status, updated_by: userId, updated_at: new Date() },
          include: siteAssigneesInclude,
        });
        const relatedUserIds = await pushNotificationService.getSiteRelatedRecipientIds(
          updatedSite.id,
          actingUser?.id
        );
        const statusRecipients = uniqueUserIds([...relatedUserIds, actingUser?.id]);
        if (actingUser?.id && statusRecipients.length) {
          const statusLabel = formatSiteStatusLabel(updatedSite?.status);
          await pushNotificationService.dispatchNotifications({
            event: "SITE_UPDATED",
            senderId: actingUser.id,
            recipientIds: statusRecipients,
            title: `${updatedSite.name}`,
            body: `${actingUser.name} (${String(actingUser?.role || "").replace(
              /_/g,
              " "
            )}) changed site status to ${statusLabel}.`,
            type: "SiteActivity",
            data: {
              siteId: updatedSite.id,
              action: "status_updated",
              siteName: updatedSite.name,
              status: statusLabel,
            },
          });
        }
        return this.sendResponse(req, res, {
          message: "Site status updated successfully",
          status: 200,
          data: updatedSite,
        });
      }

      const supervisorIds = req.body.supervisors ? getIds(req.body.supervisors) : null;
      const purchaserRows = req.body.purchasers ? normalizePurchasers(req.body.purchasers) : null;
      const seniorEngineerIds = req.body.seniorEngineers ? getIds(req.body.seniorEngineers) : null;

      const updatedSite = await prisma.site.update({
        where: { id: siteId },
        data: {
          name: req.body.name,
          address: req.body.address,
          client_name: req.body.client_name,
          city: req.body.city,
          province: req.body.province,
          plot_size: req.body.plot_size,
          status: req.body.status,
          currentStage: req.body.currentStage,
          locationUrl: req.body.locationUrl ?? req.body.location_url ?? null,
          coveredArea: req.body.coveredArea ?? req.body.covered_area ?? null,
          marketingPersonName:
            req.body.marketingPersonName ?? req.body.marketing_person_name ?? null,
          marketingPersonPhone:
            req.body.marketingPersonPhone ?? req.body.marketing_person_phone ?? null,
          startDate: toDateOrNull(req.body.startDate ?? req.body.start_date),
          endDate: toDateOrNull(req.body.endDate ?? req.body.end_date),
          updated_by: req.body.updated_by ?? userId,
          updated_at: new Date(),
          supervisors:
            supervisorIds === null
              ? undefined
              : { deleteMany: {}, create: supervisorIds.map((uid) => ({ userId: uid })) },
          purchasers:
            purchaserRows === null
              ? undefined
              : { deleteMany: {}, create: purchaserRows },
          seniorEngineers:
            seniorEngineerIds === null
              ? undefined
              : { deleteMany: {}, create: seniorEngineerIds.map((uid) => ({ userId: uid })) },
        },
        include: siteAssigneesInclude,
      });
      const currentRelatedUserIds = uniqueUserIds([
        ...(updatedSite?.supervisors || []).map((s) => s.userId),
        ...(updatedSite?.purchasers || []).map((p) => p.userId),
        ...(updatedSite?.seniorEngineers || []).map((s) => s.userId),
      ]);
      const newlyAddedUserIds = currentRelatedUserIds.filter(
        (id) => !previousRelatedUserIds.includes(id)
      );
      const fallbackRecipients = await pushNotificationService.getSiteRelatedRecipientIds(
        updatedSite.id,
        actingUser?.id
      );
      const notificationRecipients =
        newlyAddedUserIds.length > 0
          ? uniqueUserIds([...newlyAddedUserIds, ...fallbackRecipients])
          : fallbackRecipients;
      const finalRecipients = uniqueUserIds([...notificationRecipients, actingUser?.id]);
      const previousStatus = String(existingSite?.status || "").toLowerCase().trim();
      const currentStatus = String(updatedSite?.status || "").toLowerCase().trim();
      const isStatusChanged = previousStatus !== currentStatus;
      const statusLabel = formatSiteStatusLabel(updatedSite?.status);
      const notificationBody =
        newlyAddedUserIds.length > 0
          ? `You have been added to site '${updatedSite.name}' by ${actingUser?.name || "System"}.`
          : isStatusChanged
          ? `${actingUser?.name || "System"} (${String(
              actingUser?.role || ""
            ).replace(/_/g, " ")}) changed site status to ${statusLabel}.`
          : `Site '${updatedSite.name}' is updated by ${actingUser?.name || "System"}.`;
      if (actingUser?.id && finalRecipients.length) {
        await pushNotificationService.dispatchNotifications({
          event: "SITE_UPDATED",
          senderId: actingUser.id,
          recipientIds: finalRecipients,
          title: updatedSite.name,
          body: notificationBody,
          type: "SiteActivity",
          data: {
            siteId: updatedSite.id,
            action: newlyAddedUserIds.length > 0 ? "user_added" : isStatusChanged ? "status_updated" : "updated",
            siteName: updatedSite.name,
            newUsersOnly: newlyAddedUserIds.length > 0,
            status: isStatusChanged ? statusLabel : undefined,
          },
        });
      }

      return this.sendResponse(req, res, {
        message: "Site updated successfully",
        status: 200,
        data: updatedSite,
      });
    } catch (error) {
      return this.sendResponse(req, res, { message: "Failed to update site", status: 500 });
    }
  };

  delete = async (req, res) => {
    try {
      const siteId = Number(req.params.id);
      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) return this.sendResponse(req, res, { message: "Site not found", status: 404 });

      await prisma.$transaction(async (tx) => {
        const group = await tx.chatGroup.findFirst({ where: { name: site.name } });
        if (group) {
          await tx.chatMember.deleteMany({ where: { groupId: group.id } });
          await tx.chatGroup.delete({ where: { id: group.id } });
        }

        // Explicit cleanup for relations without onDelete cascade.
        await tx.extraMaterial.deleteMany({ where: { siteId } });
        await tx.request.deleteMany({ where: { siteId } });

        await tx.site.delete({ where: { id: siteId } });
      });

      return this.sendResponse(req, res, {
        message: "Site and related chat group deleted successfully",
        status: 200,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to delete site",
        status: 500,
        error: error.message,
      });
    }
  };

  getSitesWithOnlyName = async (req, res) => {
    try {
      const userId = req?.user?.id;
      const userRole = req?.user?.role;
      const allSites = await prisma.site.findMany({
        orderBy: { created_at: "desc" },
        include: siteAssigneesInclude,
      });

      const filteredSites = allSites.filter((site) => {
        if (userRole === Role.SUPERVISOR) {
          return site.supervisors.some((s) => s.userId === userId);
        }
        if (userRole === Role.PURCHASER) {
          return site.purchasers.some((p) => p.userId === userId);
        }
        if (userRole === Role.SR_ENGINEER) {
          return site.seniorEngineers.some((p) => p.userId === userId);
        }
        return true;
      });

      return this.sendResponse(req, res, {
        message: "Sites fetched successfully",
        status: 200,
        data: filteredSites.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      });
    } catch (error) {
      return this.sendResponse(req, res, { message: "Failed to fetch sites", status: 500 });
    }
  };
}

module.exports = Site;
