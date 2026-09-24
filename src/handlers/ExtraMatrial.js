const Response = require("./Response");
const { prisma } = require("../prisma");
class ExtraMaterial extends Response {
  // Create or Replace MaterialTotal for a Site
  getExtraMaterialsBySite = async (req, res) => {
    const { siteId } = req.params; // expecting /extra-material/:siteId

    try {
      const extraMaterials = await prisma.extraMaterial.findMany({
        where: { siteId: Number(siteId) },
        include: {
          product: true, // ✅ Optional — if you have a product relation
        },
        orderBy: { createdAt: "desc" },
      });

      this.sendResponse(req, res, {
        status: 200,
        message: "Extra materials fetched successfully",
        data: extraMaterials,
      });
    } catch (error) {
      console.error(error);
      this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch extra materials",
      });
    }
  };
}

module.exports = ExtraMaterial;
