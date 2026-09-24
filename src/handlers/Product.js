const prisma = require("../lib/prisma");
const Response = require("./Response");

class ProductController extends Response {
  normalizeName = (value) => String(value || "").trim().toUpperCase();

  normalizeUnit = (value) => String(value || "").trim().toLowerCase();

  // Create product
  createProduct = async (req, res) => {
    try {
      const { name, unit } = req.body;
      const normalizedName = this.normalizeName(name);
      const normalizedUnit = this.normalizeUnit(unit);

      if (!normalizedName || !normalizedUnit) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "name and unit are required",
        });
      }

      const product = await prisma.product.create({
        data: { name: normalizedName, unit: normalizedUnit },
      });

      return this.sendResponse(req, res, {
        status: 201,
        message: "Product created",
        data: product,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Product creation failed",
        error: error.message,
      });
    }
  };

  // Get all products
  getAllProducts = async (req, res) => {
    try {
      const products = await prisma.product.findMany();
      return this.sendResponse(req, res, {
        status: 200,
        message: "Products fetched",
        data: products,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to fetch products",
        error: error.message,
      });
    }
  };

  // Update product
  updateProduct = async (req, res) => {
    try {
      const { id } = req.params;
      const { name, unit } = req.body;
      const normalizedName = this.normalizeName(name);
      const normalizedUnit = this.normalizeUnit(unit);

      if (!normalizedName || !normalizedUnit) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "name and unit are required",
        });
      }

      const product = await prisma.product.update({
        where: { id: parseInt(id) },
        data: { name: normalizedName, unit: normalizedUnit },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Product updated",
        data: product,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Product update failed",
        error: error.message,
      });
    }
  };

  // Delete product
  deleteProduct = async (req, res) => {
    try {
      const { id } = req.params;
      const productId = Number(id);
      if (!Number.isFinite(productId) || productId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid product id",
        });
      }

      const existing = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!existing) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Product not found",
        });
      }

      await prisma.product.delete({
        where: { id: productId },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Product deleted",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Product deletion failed",
        error: error.message,
      });
    }
  };
  // Common response handler (optional if not inherited)
  sendResponse = (req, res, { status, message, data, error }) => {
    return res.status(status).json({ message, data, error });
  };
}

module.exports = ProductController;
