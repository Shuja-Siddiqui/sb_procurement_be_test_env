const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");

class AgreementData extends Response {
  canDeleteAgreement = (role) =>
    [Role.ADMIN, Role.SUPER_ADMIN, Role.QA].includes(role);

  normalizeAgreementFile = (value) => ({
    fileName: String(value?.fileName || "").trim(),
    mimeType: String(value?.mimeType || "application/octet-stream").trim(),
    category: String(value?.category || "agreement").trim(),
    data: String(value?.data || "").trim(),
    size: Number(value?.size) || 0,
  });

  normalizeAgreementList = (payload) => {
    const source = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray(payload.agreements)
        ? payload.agreements
        : payload
          ? [payload]
          : [];

    return source
      .map((item) => this.normalizeAgreementFile(item))
      .filter((item) => item.fileName && item.data);
  };

  createOrUpdate = async (req, res) => {
    try {
      if (req?.user?.role === Role.QA) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "QA users can only view agreement data",
        });
      }

      const siteId = Number(req.body?.siteId);
      const agreement = req.body?.agreement;
      const agreements = req.body?.agreements;

      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }

      if (!agreement && !Array.isArray(agreements)) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "agreement or agreements payload is required",
        });
      }

      const incomingAgreements = this.normalizeAgreementList(
        Array.isArray(agreements) ? agreements : agreement
      );

      if (incomingAgreements.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid agreement files are required",
        });
      }

      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Site not found",
        });
      }

      const existingRows = await prisma.agreementData.findMany({ where: { siteId } });
      const existingSignatures = new Set(
        existingRows
          .map((row) => this.normalizeAgreementFile(row?.data))
          .filter((item) => item.fileName && item.data)
          .map((item) => `${item.fileName}::${item.size}::${item.data.slice(0, 64)}`)
      );

      const rowsToCreate = incomingAgreements.filter((file) => {
        const signature = `${file.fileName}::${file.size}::${file.data.slice(0, 64)}`;
        if (existingSignatures.has(signature)) return false;
        existingSignatures.add(signature);
        return true;
      });

      if (rowsToCreate.length > 0) {
        await prisma.agreementData.createMany({
          data: rowsToCreate.map((file) => ({
            siteId,
            data: file,
          })),
        });
      }

      const saved = await prisma.agreementData.findMany({
        where: { siteId },
        orderBy: { createdAt: "desc" },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement data saved successfully",
        data: {
          siteId,
          agreements: saved.map((row) => ({
            id: row.id,
            ...this.normalizeAgreementFile(row.data),
          })),
        },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to save agreement data",
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

      const rows = await prisma.agreementData.findMany({
        where: { siteId },
        orderBy: { createdAt: "desc" },
      });
      const agreements = rows.map((row) => ({
        id: row.id,
        ...this.normalizeAgreementFile(row.data),
      }));

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement data fetched successfully",
        data: { siteId, agreement: agreements[0] || null, agreements },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch agreement data",
        error: error.message,
      });
    }
  };

  deleteBySiteId = async (req, res) => {
    try {
      if (!this.canDeleteAgreement(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "You are not allowed to delete agreement data",
        });
      }

      const siteId = Number(req.params.id);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }

      await prisma.agreementData.deleteMany({
        where: { siteId },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement data deleted successfully",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to delete agreement data",
        error: error.message,
      });
    }
  };

  deleteFileBySiteId = async (req, res) => {
    try {
      if (!this.canDeleteAgreement(req?.user?.role)) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "You are not allowed to delete agreement data",
        });
      }

      const siteId = Number(req.params.id);
      const fileId = Number(req.body?.fileId);
      const fileName = String(req.body?.fileName || "").trim();
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid siteId is required",
        });
      }
      if ((!Number.isFinite(fileId) || fileId <= 0) && !fileName) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "fileId or fileName is required",
        });
      }

      if (Number.isFinite(fileId) && fileId > 0) {
        await prisma.agreementData.deleteMany({
          where: { id: fileId, siteId },
        });
      } else {
        const rows = await prisma.agreementData.findMany({ where: { siteId } });
        for (const row of rows) {
          const normalized = this.normalizeAgreementFile(row.data);
          if (normalized.fileName === fileName) {
            await prisma.agreementData.deleteMany({
              where: { id: row.id, siteId },
            });
            break;
          }
        }
      }

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement file deleted successfully",
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to delete agreement file",
        error: error.message,
      });
    }
  };
}

module.exports = AgreementData;
