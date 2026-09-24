const prisma = require("../lib/prisma");
const Response = require("./Response");

class MaterialTotal extends Response {
  // Create or Replace MaterialTotal for a Site
  createOrUpdate = async (req, res) => {
    try {
      const { siteId, file_name, data } = req.body;

      if (!siteId || !data || !file_name) {
        return res.status(400).json({
          message: "siteId, file_name, and data are required",
          status: 400,
        });
      }

      // 1) Check site exists
      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return res.status(404).json({
          message: "Site not found",
          status: 404,
        });
      }

      // 2) Check if a materialTotal already exists for this site
      const existingMaterial = await prisma.materialTotal.findUnique({
        where: { siteId },
      });

      let result;

      if (existingMaterial) {
        // Get existing array
        let currentData = existingMaterial?.data || [];
        // Find the index of the material by description
        const index = currentData.findIndex(
          (item) => item.description === data.description
        );
        if (index !== -1) {
          // ✅ Update the existing item only
          currentData[index] = {
            ...currentData[index],
            ...data,
          };
        } else {
          // ✅ Do NOT add new item — just skip
          console.log("No matching item found — no update applied.");
        }
        // Always update DB: either data changed or stays same
        result = await prisma.materialTotal.update({
          where: { siteId },
          data: {
            data: currentData,
            file_name: file_name,
          },
        });
      } else {
        // If no record exists at all — create a new one
        result = await prisma.materialTotal.create({
          data: {
            siteId,
            data: data, // or [] if you don't want to insert anything when no match
            file_name: file_name,
          },
        });
      }

      return res.status(200).json({
        message: "Material total saved successfully",
        status: 200,
        data: result,
      });
    } catch (error) {
      console.error("Error in createOrUpdate:", error);
      return res.status(500).json({
        message: "Failed to save material total",
        status: 500,
        error: error.message,
      });
    }
  };

  // Get MaterialTotal by siteId
  getBySiteId = async (req, res) => {
    try {
      const siteId = parseInt(req.params.id);
      const material = await prisma.materialTotal.findUnique({
        where: { siteId },
      });

      if (!material) {
        return this.sendResponse(req, res, {
          message: "No material total found for this site",
          status: 404,
        });
      }

      return this.sendResponse(req, res, {
        message: "Material total fetched successfully",
        status: 200,
        data: material,
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        message: "Failed to fetch material total",
        status: 500,
      });
    }
  };

  // Delete MaterialTotal by siteId
  deleteBySiteId = async (req, res) => {
    try {
      const siteId = parseInt(req.params.id);
      await prisma.materialTotal.delete({
        where: { siteId },
      });

      return this.sendResponse(req, res, {
        message: "Material total deleted successfully",
        status: 200,
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        message: "Failed to delete material total",
        status: 500,
      });
    }
  };
}

module.exports = MaterialTotal;
