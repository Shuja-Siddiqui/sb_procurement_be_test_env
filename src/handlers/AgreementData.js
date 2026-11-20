const fs = require("fs");
const path = require("path");
const { Role } = require("@prisma/client");
const Response = require("./Response");
const prisma = require("../lib/prisma");
const { withDbRetry } = require("../lib/prisma");
const {
  UPLOADS_DIR,
  UPLOADS_ROOT,
  sanitizeFileName,
  saveToUploads,
  deleteFromUploads,
  deleteUploadByPrefix,
} = require("../lib/uploadFile");
const { getServerOrigin } = require("../lib/requestUrl");

const MAX_AGREEMENT_FILE_BYTES = 20 * 1024 * 1024; // 20MB

class AgreementData extends Response {
  canDeleteAgreement = (role) =>
    [Role.ADMIN, Role.SUPER_ADMIN, Role.QA].includes(role);

  normalizeAgreementFile = (value) => ({
    fileName: String(value?.fileName || "").trim(),
    mimeType: String(value?.mimeType || "application/octet-stream").trim(),
    category:
      String(value?.category || "agreement").trim().toLowerCase() ||
      "agreement",
    data: String(value?.data || "").trim(),
    size: Number(value?.size) || 0,
    filePath: String(value?.filePath || "").trim(),
    siteId: Number(value?.siteId) || null,
  });

  getUploadSubDir = (category, siteId) => {
    const cat =
      String(category || "agreement").toLowerCase() === "design"
        ? "design"
        : "agreement";
    const sitePart = Number.isFinite(Number(siteId)) && Number(siteId) > 0
      ? String(Number(siteId))
      : "unknown";
    // e.g. 15/agreement or 15/design
    return path.posix.join(sitePart, cat);
  };

  isPdfFile = (file) => {
    const mime = String(file?.mimeType || "").toLowerCase();
    const name = String(file?.fileName || "").toLowerCase();
    return mime === "application/pdf" || name.endsWith(".pdf");
  };

  buildFileUrl = (req, filePath) => {
    if (!filePath) return "";
    const relative = String(filePath)
      .replace(/^\/+/, "")
      .replace(new RegExp(`^${UPLOADS_DIR}/`, "i"), "");
    return `${getServerOrigin(req)}/${UPLOADS_DIR}/${relative}`;
  };

  buildContentUrl = (req, rowId) => {
    if (!rowId) return "";
    return `${getServerOrigin(req)}/agreementData/file/${rowId}`;
  };

  /**
   * List/save responses stay lean (no base64). Use getFileById for content.
   * @param {{ includeData?: boolean }} [options]
   */
  toResponseFile = (req, row, options = {}) => {
    const includeData = Boolean(options.includeData);
    const normalized = this.normalizeAgreementFile(row?.data);
    const hasInlineData = Boolean(normalized.data);
    const diskUrl = this.buildFileUrl(req, normalized.filePath);
    const fileUrl =
      diskUrl ||
      (hasInlineData ? this.buildContentUrl(req, row.id) : "");

    const payload = {
      id: row.id,
      fileName: normalized.fileName,
      mimeType: normalized.mimeType,
      category: normalized.category,
      size: normalized.size,
      siteId: normalized.siteId || row.siteId || null,
      filePath: normalized.filePath || "",
      fileUrl,
      hasData: hasInlineData || Boolean(normalized.filePath),
    };

    if (includeData) {
      payload.data = normalized.data;
    }

    return payload;
  };

  /**
   * PDFs: write to uploads first, store filePath in DB (no base64 — avoids pooler drops).
   * Images/docs: keep base64 in DB as before.
   */
  persistIncomingFile = async (db, siteId, file) => {
    const isPdf = this.isPdfFile(file);
    let filePath = "";
    let dataForDb = file.data || "";
    let tempAbsolutePath = "";

    if (isPdf) {
      const buffer = Buffer.from(String(file.data || ""), "base64");
      if (!buffer.length) {
        throw new Error(`PDF "${file.fileName}" has no content`);
      }
      const saved = saveToUploads(buffer, file.fileName || "document.pdf", {
        subDir: this.getUploadSubDir(file.category, siteId),
        prefix: `tmp-${Date.now()}`,
      });
      filePath = saved.relativePath;
      tempAbsolutePath = saved.absolutePath;
      dataForDb = ""; // do not store large PDF base64 in Postgres
    }

    const payload = {
      fileName: file.fileName,
      mimeType: file.mimeType,
      category: file.category,
      size: file.size,
      siteId: Number(siteId) || null,
      data: dataForDb,
      filePath,
    };

    const row = await db.agreementData.create({
      data: {
        siteId,
        data: payload,
      },
    });

    if (isPdf && tempAbsolutePath) {
      const subDir = this.getUploadSubDir(file.category, siteId);
      const finalName = `${row.id}-${sanitizeFileName(file.fileName || "document.pdf")}`;
      const finalAbsolute = path.join(UPLOADS_ROOT, subDir, finalName);
      fs.mkdirSync(path.dirname(finalAbsolute), { recursive: true });
      fs.renameSync(tempAbsolutePath, finalAbsolute);
      filePath = path.posix.join(subDir, finalName);
      payload.filePath = filePath;
      await db.agreementData.update({
        where: { id: row.id },
        data: { data: payload },
      });
      return { ...row, data: payload };
    }

    return row;
  };

  removeStoredFile = (rowId, file, siteId) => {
    if (!rowId && !file?.filePath) return;
    try {
      if (file?.filePath) {
        deleteFromUploads(
          String(file.filePath).replace(
            new RegExp(`^\\/?${UPLOADS_DIR}/`, "i"),
            "",
          ),
        );
        return;
      }
      if (!this.isPdfFile(file) || !rowId) return;
      const cat =
        String(file?.category || "").toLowerCase() === "design"
          ? "design"
          : "agreement";
      const site = siteId || file?.siteId;
      if (site) {
        deleteUploadByPrefix(String(rowId), path.posix.join(String(site), cat));
      }
      // legacy path before siteId folders
      deleteUploadByPrefix(String(rowId), cat);
    } catch (diskError) {
      console.error(
        "Failed to delete agreement/design file from uploads folder:",
        diskError?.message || diskError,
      );
    }
  };

  normalizeAgreementList = (payload) => {
    const source = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === "object" &&
          Array.isArray(payload.agreements)
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
        Array.isArray(agreements) ? agreements : agreement,
      );

      if (incomingAgreements.length === 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Valid agreement files are required",
        });
      }

      const oversized = incomingAgreements.find(
        (file) => Number(file.size) > MAX_AGREEMENT_FILE_BYTES,
      );
      if (oversized) {
        return this.sendResponse(req, res, {
          status: 400,
          message: `"${oversized.fileName}" exceeds 20MB. Please upload a smaller file.`,
        });
      }

      const saved = await withDbRetry(async (db) => {
        const site = await db.site.findUnique({ where: { id: siteId } });
        if (!site) {
          const notFound = new Error("Site not found");
          notFound.status = 404;
          throw notFound;
        }

        const existingRows = await db.agreementData.findMany({
          where: { siteId },
        });
        const existingSignatures = new Set(
          existingRows
            .map((row) => this.normalizeAgreementFile(row?.data))
            .filter((item) => item.fileName)
            .map((item) =>
              item.filePath
                ? `${item.fileName}::${item.size}::${item.filePath}`
                : `${item.fileName}::${item.size}::${String(item.data || "").slice(0, 64)}`,
            ),
        );

        const rowsToCreate = incomingAgreements.filter((file) => {
          const signature = `${file.fileName}::${file.size}::${String(file.data || "").slice(0, 64)}`;
          if (existingSignatures.has(signature)) return false;
          existingSignatures.add(signature);
          return true;
        });

        for (const file of rowsToCreate) {
          await this.persistIncomingFile(db, siteId, file);
        }

        return db.agreementData.findMany({
          where: { siteId },
          orderBy: { createdAt: "desc" },
        });
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement data saved successfully",
        data: {
          siteId,
          agreements: saved.map((row) => this.toResponseFile(req, row)),
        },
      });
    } catch (error) {
      if (error?.status === 404) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Site not found",
        });
      }
      console.error("Agreement createOrUpdate failed:", error);
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
      // Metadata only — base64/binary served via GET /agreementData/file/:fileId
      const agreements = rows.map((row) => this.toResponseFile(req, row));

      return this.sendResponse(req, res, {
        status: 200,
        message: "Agreement data fetched successfully",
        data: { siteId, agreements },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to fetch agreement data",
        error: error.message,
      });
    }
  };

  getFileById = async (req, res) => {
    try {
      const fileId = Number(req.params.fileId);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid file id",
        });
      }

      const row = await prisma.agreementData.findUnique({
        where: { id: fileId },
      });
      if (!row) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Agreement file not found",
        });
      }

      const file = this.normalizeAgreementFile(row.data);
      const mimeType = file.mimeType || "application/octet-stream";
      const safeName = String(file.fileName || "agreement-file").replace(
        /"/g,
        "",
      );

      if (file.filePath) {
        const relative = String(file.filePath)
          .replace(/^\/+/, "")
          .replace(new RegExp(`^${UPLOADS_DIR}/`, "i"), "");
        const absolutePath = path.join(UPLOADS_ROOT, relative);
        if (!fs.existsSync(absolutePath)) {
          return this.sendResponse(req, res, {
            status: 404,
            message: "File missing on disk",
          });
        }
        res.setHeader("Content-Type", mimeType);
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${safeName}"`,
        );
        return res.sendFile(absolutePath);
      }

      if (!file.data) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "File content not found",
        });
      }

      const buffer = Buffer.from(file.data, "base64");
      if (!buffer.length) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "File content not found",
        });
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeName}"`,
      );
      return res.send(buffer);
    } catch (error) {
      console.error("Agreement getFileById failed:", error);
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to retrieve agreement file",
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

      const existingRows = await prisma.agreementData.findMany({
        where: { siteId },
      });

      await prisma.agreementData.deleteMany({
        where: { siteId },
      });

      for (const row of existingRows) {
        this.removeStoredFile(
          row.id,
          this.normalizeAgreementFile(row.data),
          siteId,
        );
      }

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

      let deletedRow = null;
      if (Number.isFinite(fileId) && fileId > 0) {
        deletedRow = await prisma.agreementData.findFirst({
          where: { id: fileId, siteId },
        });
        if (deletedRow) {
          await prisma.agreementData.deleteMany({
            where: { id: fileId, siteId },
          });
        }
      } else {
        const rows = await prisma.agreementData.findMany({ where: { siteId } });
        for (const row of rows) {
          const normalized = this.normalizeAgreementFile(row.data);
          if (normalized.fileName === fileName) {
            deletedRow = row;
            await prisma.agreementData.deleteMany({
              where: { id: row.id, siteId },
            });
            break;
          }
        }
      }

      if (deletedRow) {
        this.removeStoredFile(
          deletedRow.id,
          this.normalizeAgreementFile(deletedRow.data),
          siteId,
        );
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
