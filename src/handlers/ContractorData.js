const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");

class ContractorData extends Response {
  normalizeContractorRows = (rows) =>
    rows
      .map((row, index) => {
        const normalizedName = String(row?.name || "").trim().toUpperCase();
        return {
          id: Number(row?.id) || index + 1,
          name: normalizedName,
          price: row?.price ?? "",
        };
      })
      .filter((row) => row.name);

  createOrUpdate = async (req, res) => {
    try {
      if (req?.user?.role === Role.QA) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "QA users can only view contractor data",
        });
      }
      const siteId = Number(req.body?.siteId);
      const data = req.body?.data;

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }
      if (!Array.isArray(data)) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "data must be an array",
        });
      }
      const normalizedData = this.normalizeContractorRows(data);

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Site not found",
        });
      }

      const payload = {
        contractors: normalizedData,
      };

      const saved = await prisma.contractorData.upsert({
        where: { siteId },
        update: { data: payload },
        create: { siteId, data: payload },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Contractor data saved successfully",
        data: saved,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to save contractor data",
        error: error.message,
      });
    }
  };

  getBySiteId = async (req, res) => {
    try {
      const siteId = Number(req.params.id);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }

      const result = await prisma.contractorData.findUnique({
        where: { siteId },
      });

      const rawData = result?.data;
      const parsedData = Array.isArray(rawData)
        ? { contractors: rawData }
        : {
            contractors: Array.isArray(rawData?.contractors) ? rawData.contractors : [],
          };

      return this.sendResponse(req, res, {
        status: 200,
        message: "Contractor data fetched successfully",
        data: result
          ? { ...result, data: parsedData.contractors }
          : { siteId, data: [] },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch contractor data",
        error: error.message,
      });
    }
  };

  deleteBySiteId = async (req, res) => {
    try {
      if (req?.user?.role === Role.QA) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "QA users can only view contractor data",
        });
      }
      const siteId = Number(req.params.id);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }

      await prisma.contractorData.deleteMany({
        where: { siteId },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Contractor data deleted successfully",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to delete contractor data",
        error: error.message,
      });
    }
  };
}

module.exports = ContractorData;
