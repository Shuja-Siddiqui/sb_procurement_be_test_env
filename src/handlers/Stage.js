const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");

const DEFAULT_PLOT_SIZES = [
  { name: "1 Marla", sortOrder: 1 },
  { name: "3 Marla", sortOrder: 2 },
  { name: "5 Marla", sortOrder: 3 },
  { name: "10 Marla", sortOrder: 4 },
  { name: "15 Marla", sortOrder: 5 },
  { name: "1 Kanal", sortOrder: 6 },
  { name: "Other", sortOrder: 99 },
];

/** Only columns that exist on the Stage table. */
const STAGE_SELECT = {
  id: true,
  name: true,
  plotSizeId: true,
  createdAt: true,
  updatedAt: true,
  plotSize: { select: { id: true, name: true, sortOrder: true } },
};

const STAGE_WITH_ITEMS_SELECT = {
  ...STAGE_SELECT,
  items: {
    include: {
      product: { select: { id: true, name: true, unit: true } },
    },
    orderBy: { id: "asc" },
  },
};

class Stage extends Response {
  hasManagementAccess = (role) =>
    [Role.SUPER_ADMIN, Role.ADMIN, Role.DIRECTOR, Role.QA].includes(role);

  ensureDefaultPlotSizes = async () => {
    const count = await prisma.plotSize.count();
    if (count > 0) return;
    await prisma.plotSize.createMany({
      data: DEFAULT_PLOT_SIZES,
      skipDuplicates: true,
    });
  };

  resolvePlotSizeId = async (raw) => {
    if (raw == null || raw === "") return null;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const byId = await prisma.plotSize.findUnique({
        where: { id: asNumber },
        select: { id: true },
      });
      return byId?.id || null;
    }
    const name = String(raw).trim();
    if (!name) return null;
    const byName = await prisma.plotSize.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    return byName?.id || null;
  };

  listPlotSizes = async (req, res) => {
    try {
      await this.ensureDefaultPlotSizes();
      const plotSizes = await prisma.plotSize.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Plot sizes fetched successfully",
        data: plotSizes,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch plot sizes",
        error: error.message,
      });
    }
  };

  createPlotSize = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to create plot size",
        });
      }

      const name = String(req.body?.name || "").trim();
      if (!name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Plot size name is required",
        });
      }

      const maxSort = await prisma.plotSize.aggregate({ _max: { sortOrder: true } });
      const sortOrder =
        Number.isFinite(Number(req.body?.sortOrder))
          ? Number(req.body.sortOrder)
          : Number(maxSort?._max?.sortOrder || 0) + 1;

      const created = await prisma.plotSize.create({
        data: { name, sortOrder },
      });
      return this.sendResponse(req, res, {
        status: 201,
        message: "Plot size created successfully",
        data: created,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to create plot size",
        error: error.message,
      });
    }
  };

  updatePlotSize = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to update plot size",
        });
      }

      const id = Number(req.params?.id);
      const name = String(req.body?.name || "").trim();
      if (!id || !name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Plot size id and name are required",
        });
      }

      const data = { name };
      if (req.body?.sortOrder != null && Number.isFinite(Number(req.body.sortOrder))) {
        data.sortOrder = Number(req.body.sortOrder);
      }

      const updated = await prisma.plotSize.update({
        where: { id },
        data,
      });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Plot size updated successfully",
        data: updated,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to update plot size",
        error: error.message,
      });
    }
  };

  deletePlotSize = async (req, res) => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: req.user?.id },
        select: { role: true },
      });
      if (!requester || !this.hasManagementAccess(requester.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "Unauthorized to delete plot size",
        });
      }

      const id = Number(req.params?.id);
      if (!id) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Plot size id is required",
        });
      }

      const existing = await prisma.plotSize.findUnique({
        where: { id },
        select: { id: true, name: true, _count: { select: { stages: true } } },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Plot size not found",
        });
      }
      if (String(existing.name).toLowerCase() === "other") {
        return this.sendResponse(req, res, {
          status: 400,
          message: "The default Other plot size cannot be deleted",
        });
      }
      if (existing._count.stages > 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Cannot delete plot size that still has stages",
        });
      }

      await prisma.plotSize.delete({ where: { id } });
      return this.sendResponse(req, res, {
        status: 200,
        message: "Plot size deleted successfully",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to delete plot size",
        error: error.message,
      });
    }
  };

  listStages = async (req, res) => {
    try {
      await this.ensureDefaultPlotSizes();

      const plotSizeParam =
        req.query.plotSizeId ?? req.query.plot_size ?? req.query.plotSize ?? "";
      const where = {};

      if (String(plotSizeParam).trim()) {
        const plotSizeId = await this.resolvePlotSizeId(plotSizeParam);
        if (!plotSizeId) {
          return this.sendResponse(req, res, {
            status: 200,
            message: "Stages fetched successfully",
            data: [],
          });
        }
        where.plotSizeId = plotSizeId;
      }

      const stages = await prisma.stage.findMany({
        where,
        select: STAGE_WITH_ITEMS_SELECT,
        orderBy: { id: "asc" },
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

      await this.ensureDefaultPlotSizes();

      const name = String(req.body?.name || "").trim();
      if (!name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Stage name is required",
        });
      }

      let plotSizeId = await this.resolvePlotSizeId(
        req.body?.plotSizeId ?? req.body?.plot_size ?? req.body?.plotSize,
      );
      if (!plotSizeId) {
        const other = await prisma.plotSize.findFirst({
          where: { name: { equals: "Other", mode: "insensitive" } },
          select: { id: true },
        });
        plotSizeId = other?.id || null;
      }

      const created = await prisma.stage.create({
        data: { name, plotSizeId },
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
      if (!stageId || !name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stage id and name are required",
        });
      }

      const data = { name };
      if (
        req.body?.plotSizeId != null ||
        req.body?.plot_size != null ||
        req.body?.plotSize != null
      ) {
        data.plotSizeId = await this.resolvePlotSizeId(
          req.body?.plotSizeId ?? req.body?.plot_size ?? req.body?.plotSize,
        );
      }

      const updated = await prisma.stage.update({
        where: { id: stageId },
        data,
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

      const existing = await prisma.stage.findUnique({
        where: { id: stageId },
        select: { id: true, name: true },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage not found",
        });
      }

      await prisma.stage.delete({ where: { id: stageId } });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Stage deleted successfully",
        data: existing,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to delete stage",
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
      const quantities =
        req.body?.quantities && typeof req.body.quantities === "object"
          ? req.body.quantities
          : {};

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
      const [existingProducts, existingStageItems] = await Promise.all([
        prisma.product.findMany({
          where: { id: { in: uniqueProductIds } },
          select: { id: true },
        }),
        prisma.stageItem.findMany({
          where: { stageId, productId: { in: uniqueProductIds } },
          select: { productId: true },
        }),
      ]);
      const existingProductIds = new Set(existingProducts.map((p) => p.id));
      const alreadyOnStage = new Set(existingStageItems.map((row) => row.productId));
      const validProductIds = uniqueProductIds.filter(
        (id) => existingProductIds.has(id) && !alreadyOnStage.has(id),
      );

      if (validProductIds.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: alreadyOnStage.size
            ? "Selected products are already on this stage"
            : "No valid products selected",
        });
      }

      await prisma.stageItem.createMany({
        data: validProductIds.map((productId) => {
          const rawQty =
            quantities[productId] ??
            quantities[String(productId)] ??
            0;
          const qty = Number(rawQty);
          return {
            stageId,
            productId,
            qty: Number.isFinite(qty) ? qty : 0,
          };
        }),
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
      if (!stageId || !itemId) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "stageId and itemId are required",
        });
      }

      const existing = await prisma.stageItem.findFirst({
        where: { id: itemId, stageId },
        select: { id: true, productId: true, qty: true },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Stage item not found",
        });
      }

      const data = {};
      if (req.body?.productId != null) {
        const productId = Number(req.body.productId);
        if (!Number.isFinite(productId) || productId <= 0) {
          return this.sendResponse(req, res, {
            status: 400,
            message: "Valid productId is required",
          });
        }
        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: { id: true },
        });
        if (!product) {
          return this.sendResponse(req, res, {
            status: 404,
            message: "Product not found",
          });
        }
        data.productId = productId;
      }

      if (req.body?.qty != null && req.body?.qty !== "") {
        const qty = Number(req.body.qty);
        if (!Number.isFinite(qty)) {
          return this.sendResponse(req, res, {
            status: 400,
            message: "Valid qty is required",
          });
        }
        data.qty = qty;
      }

      if (Object.keys(data).length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Nothing to update",
        });
      }

      const updated = await prisma.stageItem.update({
        where: { id: itemId },
        data,
        include: {
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
