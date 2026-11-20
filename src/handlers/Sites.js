const { Role } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { canUserAccessSite } = require("../lib/siteAccess");
const Response = require("./Response");
const PushNotificationService = require("./PushNotificationService");

const pushNotificationService = new PushNotificationService();

const getIds = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((i) => Number(i?.userId ?? i?.ids ?? i?.id))
    .filter((id) => Number.isFinite(id) && id > 0);

const normalizePurchasers = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      const userId = Number(item?.userId ?? item?.ids ?? item?.id);
      if (!Number.isFinite(userId) || userId <= 0) return null;
      const productIds = (Array.isArray(item?.productIds) ? item.productIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
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

/** Copy plot-size stage templates into a new site's StageMaterial + MaterialTotal. */
const seedSiteStagesFromPlotSize = async (siteId, plotSizeName) => {
  const name = String(plotSizeName || "").trim();
  if (!Number.isFinite(Number(siteId)) || !name) return null;

  const plotSize = await prisma.plotSize.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!plotSize) return null;

  const templateStages = await prisma.stage.findMany({
    where: { plotSizeId: plotSize.id },
    include: {
      items: {
        select: { productId: true, qty: true },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });
  if (!templateStages.length) return null;

  const existing = await prisma.stageMaterial.findUnique({
    where: { siteId: Number(siteId) },
    select: { id: true },
  });
  if (existing) return null;

  const stageData = {};
  const totalsMap = {};

  templateStages.forEach((stage, stageIndex) => {
    const items = (stage.items || []).map((item, itemIndex) => {
      const qty = Number(item.qty);
      const safeQty = Number.isFinite(qty) ? qty : 0;
      const productId = Number(item.productId);
      if (Number.isFinite(productId) && productId > 0) {
        if (!totalsMap[productId]) {
          totalsMap[productId] = {
            productId,
            quantity: 0,
            used_qty: 0,
            rate: 0,
            purchase_qty: 0,
            amount: 0,
          };
        }
        totalsMap[productId].quantity = Number(
          (totalsMap[productId].quantity + safeQty).toFixed(6),
        );
      }
      return {
        id: itemIndex + 1,
        productId,
        qty: safeQty,
        used_qty: 0,
        purchase_qty: 0,
        rate: 0,
        amount: 0,
      };
    });

    stageData[stage.name] = {
      stageNumber: stageIndex + 1,
      status: "Not Started",
      items,
      extraMaterial: [],
    };
  });

  await prisma.stageMaterial.create({
    data: {
      siteId: Number(siteId),
      data: stageData,
    },
  });

  await prisma.materialTotal.upsert({
    where: { siteId: Number(siteId) },
    update: {
      data: Object.values(totalsMap),
      file_name: `auto-${plotSize.name}`,
    },
    create: {
      siteId: Number(siteId),
      data: Object.values(totalsMap),
      file_name: `auto-${plotSize.name}`,
    },
  });

  const firstStageName = templateStages[0]?.name || null;
  if (firstStageName) {
    await prisma.site.update({
      where: { id: Number(siteId) },
      data: { currentStage: firstStageName },
    });
  }

  return {
    plotSize: plotSize.name,
    stageCount: templateStages.length,
    currentStage: firstStageName,
  };
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

/** Main dashboard charts/counts + overview table — minimal payload. */
const siteDashboardSelect = {
  id: true,
  name: true,
  client_name: true,
  status: true,
  created_at: true,
  currentStage: true,
  startDate: true,
  endDate: true,
};

/** Sites list cards/filters without assignee graphs. */
const siteListLiteSelect = {
  id: true,
  name: true,
  client_name: true,
  city: true,
  province: true,
  plot_size: true,
  status: true,
  created_at: true,
};

const wantsTruthyQuery = (value) =>
  ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());

const buildSiteAccessWhere = (userId, userRole) => {
  const parsedUserId = Number(userId);
  if (!Number.isFinite(parsedUserId)) return {};
  if (userRole === Role.SUPERVISOR) {
    return { supervisors: { some: { userId: parsedUserId } } };
  }
  if (userRole === Role.PURCHASER) {
    return { purchasers: { some: { userId: parsedUserId } } };
  }
  if (userRole === Role.SR_ENGINEER) {
    return { seniorEngineers: { some: { userId: parsedUserId } } };
  }
  return {};
};

const normalizeStatusFilter = (status) => {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!normalized) return null;
  if (normalized === "data uploading" || normalized === "pending") {
    return { in: ["pending", "data uploading"] };
  }
  if (normalized === "in-progress" || normalized === "in progress") {
    return { in: ["in-progress", "in progress"] };
  }
  if (normalized === "completed") {
    return { equals: "completed" };
  }
  return { equals: String(status).trim() };
};

const buildStatusCounts = (rows = []) => {
  const counts = {
    all: 0,
    uploading: 0,
    inProgress: 0,
    completed: 0,
  };
  rows.forEach((row) => {
    const count = Number(row?._count?._all || 0);
    counts.all += count;
    const status = String(row?.status || "").toLowerCase();
    if (status === "pending" || status === "data uploading") {
      counts.uploading += count;
    } else if (status === "in-progress" || status === "in progress") {
      counts.inProgress += count;
    } else if (status === "completed") {
      counts.completed += count;
    }
  });
  return counts;
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
      let supervisorIds = getIds(req.body.supervisors);
      let purchaserRows = normalizePurchasers(req.body.purchasers);
      let seniorEngineerIds = getIds(req.body.seniorEngineers);

      const requestingUser = await prisma.user.findUnique({
        where: { id: req.user?.id },
      });
      if (!requestingUser || ![Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR].includes(requestingUser.role)) {
        return this.sendResponse(req, res, {
          message: "Only admins or directors can create sites",
          status: 403,
        });
      }

      const hasNoAssignees =
        supervisorIds.length === 0 &&
        purchaserRows.length === 0 &&
        seniorEngineerIds.length === 0;

      // Admin and Super Admin may create a site without supervisor / purchaser / senior engineer.
      const canCreateWithoutAssignees = [Role.SUPER_ADMIN, Role.ADMIN].includes(
        requestingUser.role,
      );
      if (hasNoAssignees && !canCreateWithoutAssignees) {
        return this.sendResponse(req, res, {
          message:
            "Assign at least one Supervisor, Purchaser, or Senior Engineer.",
          status: 400,
        });
      }

      // Keep only user IDs that actually exist (prevents SiteSupervisor_userId_fkey 500).
      const candidateIds = uniqueUserIds([
        ...supervisorIds,
        ...purchaserRows.map((p) => p.userId),
        ...seniorEngineerIds,
      ]);
      if (candidateIds.length > 0) {
        const existingUsers = await prisma.user.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true },
        });
        const validIds = new Set(existingUsers.map((u) => Number(u.id)));
        supervisorIds = supervisorIds.filter((id) => validIds.has(id));
        purchaserRows = purchaserRows.filter((row) => validIds.has(row.userId));
        seniorEngineerIds = seniorEngineerIds.filter((id) => validIds.has(id));

        const stillNoAssignees =
          supervisorIds.length === 0 &&
          purchaserRows.length === 0 &&
          seniorEngineerIds.length === 0;
        if (stillNoAssignees && !canCreateWithoutAssignees) {
          return this.sendResponse(req, res, {
            message:
              "Selected assignees are invalid. Assign a valid Supervisor, Purchaser, or Senior Engineer.",
            status: 400,
          });
        }
      }

      // Normalize plot size to master PlotSize name when possible.
      let resolvedPlotSize = String(plot_size || "").trim();
      const plotSizeIdRaw = req.body?.plotSizeId ?? req.body?.plot_size_id;
      if (plotSizeIdRaw != null && plotSizeIdRaw !== "") {
        const byId = await prisma.plotSize.findUnique({
          where: { id: Number(plotSizeIdRaw) },
          select: { name: true },
        });
        if (byId?.name) resolvedPlotSize = byId.name;
      } else if (resolvedPlotSize) {
        const byName = await prisma.plotSize.findFirst({
          where: { name: { equals: resolvedPlotSize, mode: "insensitive" } },
          select: { name: true },
        });
        if (byName?.name) resolvedPlotSize = byName.name;
      }

      const site = await prisma.site.create({
        data: {
          name,
          address,
          client_name,
          city,
          province,
          plot_size: resolvedPlotSize,
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

      let seededStages = null;
      try {
        seededStages = await seedSiteStagesFromPlotSize(site.id, resolvedPlotSize);
      } catch (seedError) {
        console.error(
          `[Sites.create] Failed to seed stages for plot size "${resolvedPlotSize}":`,
          seedError,
        );
      }

      const refreshedSite = seededStages?.currentStage
        ? await prisma.site.findUnique({
            where: { id: site.id },
            include: siteAssigneesInclude,
          })
        : site;

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
        message: seededStages
          ? `Site created and ${seededStages.stageCount} plot-size stage(s) added automatically`
          : "Site and group created successfully",
        status: 201,
        data: {
          site: refreshedSite,
          groupId: group.id,
          seededStages,
        },
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
      const accessWhere = buildSiteAccessWhere(userId, userRole);

      const pageParam = req.query.page;
      const limitParam = req.query.limit;
      const usePagination = pageParam != null || limitParam != null;

      // Callers without page/limit get an array. Default is a slim select —
      // full assignee payload only when explicitly requested.
      if (!usePagination) {
        const includeAssignees = wantsTruthyQuery(
          req.query.includeAssignees || req.query.full,
        );
        const dashboardOnly = wantsTruthyQuery(
          req.query.dashboard || req.query.lite,
        );

        const allSites = includeAssignees
          ? await prisma.site.findMany({
              where: accessWhere,
              orderBy: { created_at: "desc" },
              include: siteAssigneesInclude,
            })
          : await prisma.site.findMany({
              where: accessWhere,
              orderBy: { created_at: "desc" },
              select: dashboardOnly ? siteDashboardSelect : siteListLiteSelect,
            });

        return this.sendResponse(req, res, {
          message: "Sites fetched successfully",
          status: 200,
          data: allSites,
        });
      }

      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const limit = Math.min(150, Math.max(1, parseInt(limitParam, 10) || 10));

      const search = String(req.query.search || "").trim();
      const city = String(req.query.city || "").trim();
      const province = String(req.query.province || "").trim();
      const plotSize = String(
        req.query.plot_size || req.query.plotSize || "",
      ).trim();
      const statusFilter = normalizeStatusFilter(req.query.status);

      const listWhere = { ...accessWhere };
      if (search) {
        listWhere.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { client_name: { contains: search, mode: "insensitive" } },
          { city: { contains: search, mode: "insensitive" } },
          { province: { contains: search, mode: "insensitive" } },
          { plot_size: { contains: search, mode: "insensitive" } },
        ];
      }
      if (city) {
        listWhere.city = { equals: city, mode: "insensitive" };
      }
      if (province) {
        listWhere.province = { equals: province, mode: "insensitive" };
      }
      if (plotSize) {
        listWhere.plot_size = { equals: plotSize, mode: "insensitive" };
      }
      if (statusFilter) {
        listWhere.status = statusFilter;
      }

      // Tab counts ignore status filter so each tab total stays correct.
      const tabCountWhere = { ...listWhere };
      delete tabCountWhere.status;

      // Count + status tabs + page rows only. City/province/plot-size filter
      // dropdowns are static (or separate APIs) — do not scan all sites here.
      const [total, statusGroups] = await Promise.all([
        prisma.site.count({ where: listWhere }),
        prisma.site.groupBy({
          by: ["status"],
          where: tabCountWhere,
          _count: { _all: true },
        }),
      ]);

      const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
      const safePage = Math.min(page, totalPages);
      const skip = (safePage - 1) * limit;

      // Site Management needs assignees/full fields; Sites/Home use lite rows.
      const includeAssignees = wantsTruthyQuery(
        req.query.includeAssignees || req.query.full,
      );
      const dashboardOnly = wantsTruthyQuery(
        req.query.dashboard || req.query.lite,
      );

      const sites = includeAssignees
        ? await prisma.site.findMany({
            where: listWhere,
            orderBy: { created_at: "desc" },
            include: siteAssigneesInclude,
            skip,
            take: limit,
          })
        : await prisma.site.findMany({
            where: listWhere,
            orderBy: { created_at: "desc" },
            select: dashboardOnly ? siteDashboardSelect : siteListLiteSelect,
            skip,
            take: limit,
          });

      return this.sendResponse(req, res, {
        message: "Sites fetched successfully",
        status: 200,
        data: {
          items: sites,
          pagination: {
            page: safePage,
            limit,
            total,
            totalPages,
            from: total === 0 ? 0 : skip + 1,
            to: Math.min(skip + sites.length, total),
          },
          statusCounts: buildStatusCounts(statusGroups),
        },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to fetch sites",
        status: 500,
        error: error.message,
      });
    }
  };

  getById = async (req, res) => {
    try {
      const id = Number(req.params.id);
      const lite =
        String(req.query.lite || req.query.summary || "")
          .trim()
          .toLowerCase() === "1" ||
        String(req.query.lite || req.query.summary || "")
          .trim()
          .toLowerCase() === "true";

      const site = lite
        ? await prisma.site.findUnique({
            where: { id },
            select: {
              id: true,
              name: true,
              client_name: true,
              status: true,
              currentStage: true,
              startDate: true,
              endDate: true,
              city: true,
              province: true,
              plot_size: true,
            },
          })
        : await prisma.site.findUnique({
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

  updateCurrentStage = async (req, res) => {
    try {
      const siteId = Number(req.params.id);
      const userId = req?.user?.id;
      const userRole = req?.user?.role;
      const currentStage = req.body?.currentStage;

      if (currentStage === undefined || currentStage === null || currentStage === "") {
        return this.sendResponse(req, res, {
          message: "currentStage is required",
          status: 400,
        });
      }

      const existingSite = await prisma.site.findUnique({
        where: { id: siteId },
        select: {
          id: true,
          name: true,
          currentStage: true,
          supervisors: { select: { userId: true } },
        },
      });

      if (!existingSite) {
        return this.sendResponse(req, res, { message: "Site not found", status: 404 });
      }

      const isAdmin = userRole === Role.ADMIN || userRole === Role.SUPER_ADMIN;
      const isAssignedSupervisor =
        userRole === Role.SUPERVISOR &&
        existingSite.supervisors?.some((s) => s.userId === userId);

      if (!isAdmin && !isAssignedSupervisor) {
        return this.sendResponse(req, res, {
          message: "Unauthorized to update current stage",
          status: 403,
        });
      }

      const updatedSite = await prisma.site.update({
        where: { id: siteId },
        data: {
          currentStage,
          updated_by: userId,
          updated_at: new Date(),
        },
        select: {
          id: true,
          currentStage: true,
          name: true,
        },
      });

      // Fire-and-forget notifications — do not block the response.
      if (existingSite.currentStage !== updatedSite.currentStage) {
        Promise.resolve()
          .then(async () => {
            const actingUser = await prisma.user.findUnique({
              where: { id: userId },
              select: { id: true, name: true, role: true },
            });
            if (!actingUser?.id) return;

            const relatedUserIds =
              await pushNotificationService.getSiteRelatedRecipientIds(
                updatedSite.id,
                actingUser.id
              );
            const recipients = uniqueUserIds([...relatedUserIds, actingUser.id]);
            if (!recipients.length) return;

            await pushNotificationService.dispatchNotifications({
              event: "SITE_UPDATED",
              senderId: actingUser.id,
              recipientIds: recipients,
              title: `${updatedSite.name}`,
              body: `${actingUser.name} (${String(actingUser?.role || "").replace(
                /_/g,
                " "
              )}) changed current stage to ${updatedSite.currentStage}.`,
              type: "SiteActivity",
              data: {
                siteId: updatedSite.id,
                action: "current_stage_updated",
                siteName: updatedSite.name,
                currentStage: updatedSite.currentStage,
              },
            });
          })
          .catch((err) => {
            console.error(
              `[Sites.updateCurrentStage] notification failed for site ${siteId}:`,
              err?.message || err
            );
          });
      }

      return this.sendResponse(req, res, {
        message: "Current stage updated successfully",
        status: 200,
        data: {
          id: updatedSite.id,
          currentStage: updatedSite.currentStage,
        },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        message: "Failed to update current stage",
        status: 500,
        error: error.message,
      });
    }
  };

  delete = async (req, res) => {
    try {
      const siteId = Number(req.params.id);
      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          message: "Site not found",
          status: 404,
        });
      }

      const actorId = Number(req.user?.id) || null;
      const actor = actorId
        ? await prisma.user.findUnique({
            where: { id: actorId },
            select: { id: true, name: true, role: true },
          })
        : null;

      await prisma.$transaction(async (tx) => {
        const group = await tx.chatGroup.findFirst({
          where: { name: site.name },
        });
        if (group) {
          await tx.chatMember.deleteMany({ where: { groupId: group.id } });
          await tx.chatGroup.delete({ where: { id: group.id } });
        }

        // Explicit cleanup for relations without onDelete cascade.
        await tx.extraMaterial.deleteMany({ where: { siteId } });
        await tx.request.deleteMany({ where: { siteId } });

        await tx.site.delete({ where: { id: siteId } });
      });

      // Notify Admin / Super Admin (exclude the actor who deleted).
      const admins = await prisma.user.findMany({
        where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN] } },
        select: { id: true },
      });
      const recipientIds = uniqueUserIds(
        admins.map((u) => u.id).filter((id) => id !== actorId),
      );

      if (recipientIds.length > 0) {
        const message = pushNotificationService.buildSiteActivityMessage({
          action: "deleted",
          actorRole: actor?.role || req.user?.role,
          actorName: actor?.name || req.user?.name || "User",
          siteName: site.name,
        });
        pushNotificationService
          .dispatchNotifications({
            event: "SITE_DELETED",
            senderId: actorId,
            recipientIds,
            title: message.title,
            body: message.body,
            type: message.type,
            data: {
              siteId,
              action: "deleted",
              siteName: site.name,
            },
          })
          .catch((err) => {
            console.error(
              "[Sites.delete] failed to notify admins:",
              err?.message || err,
            );
          });
      }

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
