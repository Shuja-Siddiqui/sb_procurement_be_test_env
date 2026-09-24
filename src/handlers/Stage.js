const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");

/** Only columns that exist on the Stage table (no stageNumber). */
const STAGE_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
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

  listStages = async (req, res) => {
    try {
      const stages = await prisma.stage.findMany({
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

      const name = String(req.body?.name || "").trim();
      if (!name) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Stage name is required",
        });
      }

      const created = await prisma.stage.create({
        data: { name },
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

      const updated = await prisma.stage.update({
        where: { id: stageId },
        data: { name },
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
          qty: 0,
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
