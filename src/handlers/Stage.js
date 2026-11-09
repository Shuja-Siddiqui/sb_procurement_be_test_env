const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");

const DEFAULT_PLOT_SIZES = [
  "1 Marla",
  "3 Marla",
  "5 Marla",
  "10 Marla",
  "1 Kanal",
  "Other",
];

const normalizePlotSize = (value) => {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const match = DEFAULT_PLOT_SIZES.find(
    (option) => option.toLowerCase() === raw.toLowerCase(),
  );
  if (match) return match;
  // Allow custom plot sizes added from the UI.
  return raw;
};

const resolvePlotSizeForSave = (value) => normalizePlotSize(value) || "Other";

/** Only columns that exist on the Stage table (no stageNumber). */
const STAGE_SELECT = {
  id: true,
  name: true,
  plot_size: true,
  createdAt: true,
  updatedAt: true,
};

const STAGE_WITH_ITEMS_SELECT = {
  ...STAGE_SELECT,
  items: {
    select: {
      id: true,
      stageId: true,
      productId: true,
      qty: true,
      createdAt: true,
      updatedAt: true,
      product: { select: { id: true, name: true, unit: true } },
    },
    orderBy: { id: "asc" },
  },
};

class Stage extends Response {
  hasManagementAccess = (role) =>
    [Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR, Role.QA].includes(role);

  listStages = async (req, res) => {
    try {
      const plotSize = normalizePlotSize(
        req.query.plot_size || req.query.plotSize || "",
      );
      let where = {};
      if (plotSize === "Other") {
        where = {
          OR: [{ plot_size: "Other" }, { plot_size: "" }],
        };
      } else if (plotSize) {
        where = { plot_size: { equals: plotSize, mode: "insensitive" } };
      }

      const stages = await prisma.stage.findMany({
        where,
        select: STAGE_WITH_ITEMS_SELECT,
        orderBy: [{ plot_size: "asc" }, { id: "asc" }],
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Stages fetched successfully",
        data: stages,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch stages",
        error: error.message,
      });
    }
  };

  createStage = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to create stage",
        });
      }

      const name = String(req.body?.name || "").trim();
      const plotSize = resolvePlotSizeForSave(
        req.body?.plot_size || req.body?.plotSize || "",
      );
      if (!name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Stage name is required",
        });
      }

      const created = await prisma.stage.create({
        data: { name, plot_size: plotSize },
        select: STAGE_SELECT,
      });
      return this.sendResponse(req, res, {
        status: 201,
        message: "Stage created successfully",
        data: created,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to create stage",
        error: error.message,
      });
    }
  };

  updateStage = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to update stage",
        });
      }

      const stageId = Number(req.params?.id);
      const name = String(req.body?.name || "").trim();
      const plotSize = resolvePlotSizeForSave(
        req.body?.plot_size || req.body?.plotSize || "",
      );
      if (!stageId || !name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stage id and name are required",
        });
      }

      const updated = await prisma.stage.update({
        where: { id: stageId },
        data: { name, plot_size: plotSize },
        select: STAGE_SELECT,
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Stage updated successfully",
        data: updated,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update stage",
        error: error.message,
      });
    }
  };

  renamePlotSize = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to rename plot size",
        });
      }

      const fromRaw = String(req.body?.from || req.body?.oldPlotSize || "").trim();
      const toRaw = String(req.body?.to || req.body?.newPlotSize || "").trim();
      const from = normalizePlotSize(fromRaw) || fromRaw.replace(/\s+/g, " ");
      const to = normalizePlotSize(toRaw) || toRaw.replace(/\s+/g, " ");

      if (!from || !to) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Current and new plot size are required",
        });
      }
      if (from.toLowerCase() === "other") {
        return this.sendResponse(req, res, {
          status: 400,
          message: '"Other" cannot be renamed',
        });
      }
      if (to.toLowerCase() === "other") {
        return this.sendResponse(req, res, {
          status: 400,
          message: 'Cannot rename a plot size to "Other"',
        });
      }
      if (from.toLowerCase() === to.toLowerCase()) {
        return this.sendResponse(req, res, {
          status: 200,
          message: "Plot size unchanged",
          data: { updated: 0, from, to },
        });
      }

      const sourceStages = await prisma.stage.findMany({
        where: { plot_size: { equals: from, mode: "insensitive" } },
        select: { id: true, name: true, plot_size: true },
      });

      if (!sourceStages.length) {
        return this.sendResponse(req, res, {
          status: 200,
          message: "No stages found for this plot size",
          data: { updated: 0, from, to },
        });
      }

      const targetNames = await prisma.stage.findMany({
        where: {
          plot_size: { equals: to, mode: "insensitive" },
          name: { in: sourceStages.map((stage) => stage.name) },
        },
        select: { name: true },
      });
      if (targetNames.length) {
        return this.sendResponse(req, res, {
          status: 400,
          message: `Cannot rename: these stage names already exist for "${to}": ${targetNames
            .map((row) => row.name)
            .join(", ")}`,
        });
      }

      const updated = await prisma.stage.updateMany({
        where: { id: { in: sourceStages.map((stage) => stage.id) } },
        data: { plot_size: to },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Plot size renamed successfully",
        data: { updated: updated.count, from, to },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to rename plot size",
        error: error.message,
      });
    }
  };

  addStageItem = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to add stage item",
        });
      }

      const stageId = Number(req.params?.id);
      const productId = Number(req.body?.productId);
      const inputQty = req.body?.qty;

      if (!stageId || !productId) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stageId and productId are required",
        });
      }

      const [stage, product] = await Promise.all([
        prisma.stage.findUnique({
          where: { id: stageId },
          select: { id: true },
        }),
        prisma.product.findUnique({ where: { id: productId } }),
      ]);

      if (!stage || !product) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage or product not found",
        });
      }

      let qty = Number(inputQty);
      if (!Number.isFinite(qty)) {
        const lastItem = await prisma.stageItem.findFirst({
          where: { productId },
          orderBy: { createdAt: "desc" },
          select: { qty: true },
        });
        qty = Number(lastItem?.qty || 0);
      }

      const created = await prisma.stageItem.create({
        data: {
          stageId,
          productId,
          qty,
        },
        include: {
          product: { select: { id: true, name: true, unit: true } },
        },
      });

      return this.sendResponse(req, res, {
        status: 201,
        message: "Stage item added successfully",
        data: created,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to add stage item",
        error: error.message,
      });
    }
  };

  addStageItemsBulk = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to add stage items",
        });
      }

      const stageId = Number(req.params?.id);
      const productIds = Array.isArray(req.body?.productIds)
        ? req.body.productIds.map((id) => Number(id)).filter(Boolean)
        : [];
      const qtyByProductId = {};
      if (req.body?.items && typeof req.body.items === "object") {
        Object.entries(req.body.items).forEach(([productId, qty]) => {
          const pid = Number(productId);
          const value = Number(qty);
          if (pid && Number.isFinite(value)) qtyByProductId[pid] = value;
        });
      }
      const defaultQty = Number(req.body?.qty);
      const fallbackQty = Number.isFinite(defaultQty) ? defaultQty : 0;

      if (!stageId || productIds.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stageId and at least one productId are required",
        });
      }

      const stage = await prisma.stage.findUnique({
        where: { id: stageId },
        select: { id: true },
      });
      if (!stage) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage not found",
        });
      }

      const uniqueProductIds = [...new Set(productIds)];
      const existingProducts = await prisma.product.findMany({
        where: { id: { in: uniqueProductIds } },
        select: { id: true },
      });
      const existingProductIds = new Set(existingProducts.map((p) => p.id));
      const validProductIds = uniqueProductIds.filter((id) => existingProductIds.has(id));

      if (validProductIds.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "No valid products selected",
        });
      }

      await prisma.stageItem.createMany({
        data: validProductIds.map((productId) => ({
          stageId,
          productId,
          qty: Object.prototype.hasOwnProperty.call(qtyByProductId, productId)
            ? qtyByProductId[productId]
            : fallbackQty,
        })),
      });

      const stageWithItems = await prisma.stage.findUnique({
        where: { id: stageId },
        select: STAGE_WITH_ITEMS_SELECT,
      });

      return this.sendResponse(req, res, {
        status: 201,
        message: "Stage items added successfully",
        data: stageWithItems,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to add stage items",
        error: error.message,
      });
    }
  };

  updateStageItem = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to update stage item",
        });
      }

      const stageId = Number(req.params?.id);
      const itemId = Number(req.params?.itemId);
      const qty = Number(req.body?.qty);
      if (!stageId || !itemId || !Number.isFinite(qty) || qty < 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stageId, itemId and a valid qty are required",
        });
      }

      const item = await prisma.stageItem.findFirst({
        where: { id: itemId, stageId },
        select: { id: true },
      });
      if (!item) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage item not found",
        });
      }

      const updated = await prisma.stageItem.update({
        where: { id: itemId },
        data: { qty },
        select: {
          id: true,
          stageId: true,
          productId: true,
          qty: true,
          product: { select: { id: true, name: true, unit: true } },
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Stage item updated successfully",
        data: updated,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update stage item",
        error: error.message,
      });
    }
  };

  deleteStage = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to delete stage",
        });
      }

      const stageId = Number(req.params?.id);
      if (!stageId) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stage id is required",
        });
      }

      const stage = await prisma.stage.findUnique({
        where: { id: stageId },
        select: { id: true, name: true },
      });
      if (!stage) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage not found",
        });
      }

      // StageItem rows cascade via FK onDelete: Cascade.
      await prisma.stage.delete({ where: { id: stageId } });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Stage deleted successfully",
        data: stage,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to delete stage",
        error: error.message,
      });
    }
  };

  deleteStageItem = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to delete stage item",
        });
      }

      const stageId = Number(req.params?.id);
      const itemId = Number(req.params?.itemId);
      if (!stageId || !itemId) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stageId and itemId are required",
        });
      }

      const item = await prisma.stageItem.findFirst({
        where: { id: itemId, stageId },
        select: { id: true },
      });
      if (!item) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage item not found",
        });
      }

      await prisma.stageItem.delete({ where: { id: itemId } });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Stage item deleted successfully",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to delete stage item",
        error: error.message,
      });
    }
  };
}

module.exports = Stage;
