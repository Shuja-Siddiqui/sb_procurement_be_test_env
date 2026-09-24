const { RequestStatus, StageName } = require("@prisma/client");
const sharp = require("sharp");
const prisma = require("../lib/prisma");
const { canUserAccessSite } = require("../lib/siteAccess");
const Response = require("./Response");

const toFloat = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeStatus = (status) => {
  if (!status) return RequestStatus.PENDING;
  const value = String(status).toUpperCase();
  return RequestStatus[value] || RequestStatus.PENDING;
};

const normalizeStageName = (stageName) => {
  if (!stageName) return null;
  const value = String(stageName).toUpperCase();
  return StageName[value] || null;
};

const VALID_PRIORITIES = ["low", "medium", "high"];
const STEEL_SIZE_FACTOR = {
  8: 1.2125,
  6: 0.6825,
  5: 0.47,
  4: 0.3,
  3: 0.175,
  2: 0.09,
};
const roundSteelQty = (value) =>
  Number((Number(value || 0) + Number.EPSILON).toFixed(2));
const normalizeSteelItemsPayload = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      const size = toFloat(item?.size ?? item?.steel_size ?? item?.steelSize);
      const length = toFloat(item?.length ?? item?.steel_length ?? item?.steelLength);
      const factor = STEEL_SIZE_FACTOR[size] || 0;
      const totalKg =
        Number.isFinite(size) &&
        Number.isFinite(length) &&
        size > 0 &&
        length > 0 &&
        factor > 0
          ? roundSteelQty(factor * length)
          : null;
      return { size, length, totalKg };
    })
    .filter(
      (item) =>
        Number.isFinite(item?.size) &&
        Number.isFinite(item?.length) &&
        Number.isFinite(item?.totalKg) &&
        item.size > 0 &&
        item.length > 0 &&
        item.totalKg > 0
    );

const serializeSteelItems = (steelItes) =>
  normalizeSteelItemsPayload(Array.isArray(steelItes) ? steelItes : []);

const normalizeStageStatus = (status) => {
  const value = String(status || "PENDING").toUpperCase();
  if (
    value === "APPROVED" ||
    value === "REJECTED" ||
    value === "PENDING" ||
    value === "CONFLICT"
  ) {
    return value;
  }
  return "PENDING";
};

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const stagePayloadToRows = (requestId, payload = {}, currentUserId) => {
  const arrayRows = Array.isArray(payload.stages)
    ? payload.stages
        .map((item) => {
          const stageName = normalizeStageName(item?.stageName);
          const userId = Number(item?.userId ?? item?.user_id ?? currentUserId);
          if (!stageName || !Number.isFinite(userId) || userId <= 0) return null;
          return {
            requestId,
            stageName,
            status: normalizeStageStatus(item?.status),
            comment: item?.comment || null,
            userId,
            stageImageId: Number(item?.stageImageId ?? item?.stage_image_id ?? item?.imageId) || null,
            receivedAt: toDate(item?.receivedAt ?? item?.received_at),
            forwardAt: toDate(item?.forwardAt ?? item?.forward_at),
          };
        })
        .filter(Boolean)
    : [];

  const deduped = new Map();
  [...arrayRows].forEach((row) => {
    deduped.set(row.stageName, row);
  });
  return Array.from(deduped.values());
};

const deriveRequestStatus = (request, stages = []) => {
  const hasConflictStage = stages.some(
    (stage) => String(stage.status || "").toUpperCase() === "CONFLICT"
  );
  if (hasConflictStage) return RequestStatus.CONFLICT;

  const hasRejectedStage = stages.some(
    (stage) => String(stage.status || "").toUpperCase() === "REJECTED"
  );
  if (hasRejectedStage) return RequestStatus.REJECTED;

  const hasReceivingApprovedStage = stages.some(
    (stage) =>
      String(stage?.stageName || "").toUpperCase() === "RECEIVING" &&
      String(stage?.status || "").toUpperCase() === "APPROVED"
  );
  if (hasReceivingApprovedStage) return RequestStatus.APPROVED;

  const releasedQty = toFloat(request.releasedQty ?? request.released_qty) ?? 0;
  const receivedQty = toFloat(request.receivedQty ?? request.received_qty) ?? 0;
  if (releasedQty > 0 && receivedQty > 0 && receivedQty >= releasedQty) {
    return RequestStatus.APPROVED;
  }

  const hasApprovedStage = stages.some(
    (stage) => String(stage.status || "").toUpperCase() === "APPROVED"
  );
  if (hasApprovedStage || releasedQty > 0 || receivedQty > 0) {
    return RequestStatus.IN_PROGRESS;
  }
  return RequestStatus.PENDING;
};

const serializeRequest = (request) => {
  const stages = Array.isArray(request?.stages) ? request.stages : [];
  const steelItem = serializeSteelItems(request?.steelItes);
  const sanitaryImage = request?.sanitaryImage || null;
  const stageWiseQty = request?.stageWiseQty || null;
  const totalMaterial = toFloat(request?.qty) ?? 0;
  const releasedQty = toFloat(request?.releasedQty) ?? 0;
  const receivedQty = toFloat(request?.receivedQty) ?? 0;
  const usedMaterial = receivedQty > 0 ? receivedQty : releasedQty;
  const remainingMaterial = Number(Math.max(totalMaterial - usedMaterial, 0).toFixed(6));
  return {
    ...request,
    status: String(request?.status || RequestStatus.PENDING).toLowerCase(),
    total_material: totalMaterial,
    used_material: usedMaterial,
    remaining_material: remainingMaterial,
    totalMaterial,
    usedMaterial,
    remainingMaterial,
    released_qty: releasedQty,
    received_qty: receivedQty,
    steelItem,
    steel_items: steelItem,
    sanitaryImage,
    sanitary_image: sanitaryImage,
    stageWiseQty,
    stage_wise_qty: stageWiseQty,
    stages,
  };
};

const getApprovedQtyForRequest = (request) => {
  const received = toFloat(request?.receivedQty);
  if (received && received > 0) return received;
  const released = toFloat(request?.releasedQty);
  if (released && released > 0) return released;
  return toFloat(request?.qty) || 0;
};

const normalizeStageLabel = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bgorund\b/g, "ground");

const getStageWords = (value) =>
  normalizeStageLabel(value)
    .split(/\s+/)
    .filter(Boolean);

const scoreStageMatch = (requestStage, materialStage) => {
  const requestWords = getStageWords(requestStage);
  const materialWords = getStageWords(materialStage);
  if (!requestWords.length || !materialWords.length) return 0;
  const requestSet = new Set(requestWords);
  const shared = materialWords.filter((word) => requestSet.has(word)).length;
  const exactBonus =
    normalizeStageLabel(requestStage) === normalizeStageLabel(materialStage) ? 1 : 0;
  return shared / Math.max(requestWords.length, materialWords.length, 1) + exactBonus;
};

const resolveStageMaterialKey = (requestStage, materialStageKeys) => {
  const trimmed = String(requestStage || "").trim();
  if (!trimmed || !materialStageKeys.length) return null;

  const exact = materialStageKeys.find(
    (key) => normalizeStageLabel(key) === normalizeStageLabel(trimmed),
  );
  if (exact) return exact;

  let bestKey = null;
  let bestScore = 0;
  materialStageKeys.forEach((key) => {
    const score = scoreStageMatch(trimmed, key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  });
  return bestScore >= 0.5 ? bestKey : null;
};

const normalizeConstructionStageStatus = (status) => {
  const raw = String(status || "").trim().toLowerCase();
  if (raw === "completed") return "completed";
  if (raw === "in progress" || raw === "in_progress") return "in_progress";
  if (raw === "not started" || raw === "not_started") return "not_started";
  return raw;
};

const isConstructionStageCompleted = (section) =>
  normalizeConstructionStageStatus(section?.status) === "completed";

const findCompletedStageInRequest = (stageMaterial, stageWiseQty) => {
  const stageData = stageMaterial?.data;
  if (!stageData || typeof stageData !== "object") return null;

  const payload =
    stageWiseQty && typeof stageWiseQty === "object" ? stageWiseQty : null;
  if (!payload) return null;

  const materialStageKeys = Object.keys(stageData);
  const completedKeys = new Set(
    Object.entries(stageData)
      .filter(([, section]) => isConstructionStageCompleted(section))
      .map(([key]) => key),
  );

  for (const requestedStage of Object.keys(payload)) {
    if (completedKeys.has(requestedStage)) return requestedStage;
    const resolved = resolveStageMaterialKey(requestedStage, materialStageKeys);
    if (resolved && completedKeys.has(resolved)) return resolved;
  }

  return null;
};

const recalculateSiteStageUsage = async (siteId) => {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { currentStage: true },
  });
  const currentStage = site?.currentStage || null;

  const stageMaterial = await prisma.stageMaterial.findUnique({ where: { siteId } });
  if (!stageMaterial?.data) return;

  const stageData = JSON.parse(JSON.stringify(stageMaterial.data || {}));
  const materialStageKeys = Object.keys(stageData);

  const finalizedRequests = await prisma.request.findMany({
    where: {
      siteId,
      status: { in: [RequestStatus.APPROVED, RequestStatus.CONFLICT] },
    },
    select: {
      productId: true,
      qty: true,
      releasedQty: true,
      receivedQty: true,
      stageName: true,
      stageWiseQty: true,
    },
  });

  const approvedByStageProduct = new Map();
  finalizedRequests.forEach((req) => {
    const approvedQty = getApprovedQtyForRequest(req);
    const stageWiseQty =
      req?.stageWiseQty && typeof req.stageWiseQty === "object"
        ? req.stageWiseQty
        : null;
    const stageEntries = stageWiseQty
      ? Object.entries(stageWiseQty)
          .map(([stage, qty]) => [
            resolveStageMaterialKey(stage, materialStageKeys),
            toFloat(qty) || 0,
          ])
          .filter(([stage, qty]) => Boolean(stage) && qty > 0)
      : [];

    if (stageEntries.length > 0) {
      const stageWiseTotal = stageEntries.reduce((sum, [, qty]) => sum + qty, 0);
      const ratio = stageWiseTotal > 0 ? approvedQty / stageWiseTotal : 1;
      stageEntries.forEach(([stage, qty]) => {
        const mapKey = `${String(stage).toUpperCase()}::${req.productId}`;
        const normalizedQty = Number((qty * ratio).toFixed(6));
        approvedByStageProduct.set(
          mapKey,
          Number((Number(approvedByStageProduct.get(mapKey) || 0) + normalizedQty).toFixed(6))
        );
      });
      return;
    }

    const resolvedStage = resolveStageMaterialKey(
      currentStage,
      materialStageKeys,
    );
    const stageKey = resolvedStage
      ? String(resolvedStage).toUpperCase()
      : "";
    if (!stageKey) return;
    const mapKey = `${stageKey}::${req.productId}`;
    approvedByStageProduct.set(
      mapKey,
      Number((Number(approvedByStageProduct.get(mapKey) || 0) + approvedQty).toFixed(6))
    );
  });

  Object.keys(stageData).forEach((stageKey) => {
    const section = stageData[stageKey];
    if (!section || !Array.isArray(section.items)) return;
    const normalizedStageKey = String(stageKey || "").toUpperCase();
    section.items = section.items.map((item) => {
      const totalQty = toFloat(item.qty) || 0;
      const usedQty = Number(
        approvedByStageProduct.get(`${normalizedStageKey}::${item.productId}`) || 0
      );
      const remaining = Number(Math.max(totalQty - usedQty, 0).toFixed(6));
      return {
        ...item,
        used_qty: usedQty,
        approved_qty: usedQty,
        remaining_material: remaining,
      };
    });
    stageData[stageKey] = section;
  });
  await prisma.stageMaterial.update({
    where: { siteId },
    data: { data: stageData },
  });

  // Keep total material table consistent with stage-level approved usage.
  const totalsMap = new Map();
  Object.values(stageData || {}).forEach((stage) => {
    (stage?.items || []).forEach((item) => {
      const productId = Number(item?.productId);
      if (!Number.isFinite(productId)) return;
      const qty = toFloat(item?.qty) || 0;
      const usedQty = toFloat(item?.approved_qty ?? item?.used_qty) || 0;
      const purchaseQty = toFloat(item?.purchase_qty) || 0;
      const amount = toFloat(item?.amount) || 0;
      const rate = toFloat(item?.rate) || 0;
      const prev = totalsMap.get(productId) || {
        productId,
        quantity: 0,
        used_qty: 0,
        approved_qty: 0,
        purchase_qty: 0,
        amount: 0,
        rate: 0,
      };
      totalsMap.set(productId, {
        ...prev,
        quantity: Number((prev.quantity + qty).toFixed(6)),
        used_qty: Number((prev.used_qty + usedQty).toFixed(6)),
        approved_qty: Number((prev.approved_qty + usedQty).toFixed(6)),
        purchase_qty: Number((prev.purchase_qty + purchaseQty).toFixed(6)),
        amount: Number((prev.amount + amount).toFixed(6)),
        rate: rate || prev.rate,
      });
    });
  });

  const materialTotalData = Array.from(totalsMap.values()).map((row) => ({
    ...row,
    remaining_material: Number(Math.max((row.quantity || 0) - (row.used_qty || 0), 0).toFixed(6)),
  }));

  await prisma.materialTotal.upsert({
    where: { siteId },
    update: { data: materialTotalData },
    create: {
      siteId,
      data: materialTotalData,
      file_name: "Auto Synced",
    },
  });
};

class Requests extends Response {
  ensureSiteAccess = async (req, res, siteId) => {
    const allowed = await canUserAccessSite({
      userId: req?.user?.id,
      role: req?.user?.role,
      siteId,
    });
    if (!allowed) {
      this.sendResponse(req, res, {
        status: 403,
        message: "You do not have access to this site's material requests",
      });
      return false;
    }
    return true;
  };

  uploadSanitaryImage = async (req, res) => {
    try {
      console.log(req?.files,"req?.files")
      const image = req?.files?.image;
      if (!image) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Image file is required",
        });
      }
      if (!String(image.mimetype || "").startsWith("image/")) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Only image files are allowed",
        });
      }
      const requestImageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const fileName = `${requestImageId}.webp`;
      const webpBuffer = await sharp(image.data)
        .rotate()
        .webp({ quality: 70, effort: 6 })
        .toBuffer();
      const imageRow = await prisma.requestImage.create({
        data: {
          fileName,
          mimeType: "image/webp",
          size: Number(webpBuffer?.length || 0),
          data: webpBuffer,
        },
      });
      const baseUrl = `${req.protocol}://${req.get("host")}/api/v1`;
      const fileUrl = `${baseUrl}/request/sanitary-image/${imageRow.id}`;
      return this.sendResponse(req, res, {
        status: 201,
        message: "Image uploaded successfully",
        data: {
          id: imageRow.id,
          fileName,
          url: fileUrl,
          type: "image/webp",
          size: Number(webpBuffer?.length || 0),
        },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to upload image",
        error: error.message,
      });
    }
  };

  getSanitaryImage = async (req, res) => {
    try {
      const imageId = Number(req.params.id);
      if (!Number.isFinite(imageId)) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid image id",
        });
      }
      const imageRow = await prisma.requestImage.findUnique({
        where: { id: imageId },
      });
      if (!imageRow?.data) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Image not found",
        });
      }
      res.setHeader("Content-Type", imageRow.mimeType || "image/webp");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.send(Buffer.from(imageRow.data));
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Failed to retrieve image",
        error: error.message,
      });
    }
  };

  createRequests = async (req, res) => {
    try {
      const {
        productId,
        qty,
        steel_size,
        steelSize,
        steel_length,
        steelLength,
        steel_items,
        steelItems,
        sanitary_image,
        sanitaryImage,
        priority,
        released_qty,
        releasedQty,
        received_qty,
        receivedQty,
        status,
        siteId,
        stageName,
        stageWiseQty,
        stage_wise_qty,
      } = req.body;

      const parsedSiteId = Number(siteId);
      const parsedProductId = Number(productId);
      const parsedQty = toFloat(qty);
      const normalizedPriority = String(priority || "medium").toLowerCase();
      if (!Number.isFinite(parsedSiteId) || !Number.isFinite(parsedProductId)) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Invalid siteId or productId",
        });
      }
      if (!VALID_PRIORITIES.includes(normalizedPriority)) {
        return this.sendResponse(req, res, { status: 400, message: "Invalid priority value" });
      }

      const [siteExists, productExists] = await Promise.all([
        prisma.site.findUnique({ where: { id: parsedSiteId } }),
        prisma.product.findUnique({ where: { id: parsedProductId } }),
      ]);

      if (!siteExists || !productExists) {
        return this.sendResponse(req, res, {
          status: 404,
          message: !siteExists ? "Site not found" : "Product not found",
        });
      }
      if (!(await this.ensureSiteAccess(req, res, parsedSiteId))) return;

      const requestStageWiseQty =
        stageWiseQty && typeof stageWiseQty === "object"
          ? stageWiseQty
          : stage_wise_qty && typeof stage_wise_qty === "object"
            ? stage_wise_qty
            : null;
      if (requestStageWiseQty && Object.keys(requestStageWiseQty).length > 0) {
        const stageMaterial = await prisma.stageMaterial.findUnique({
          where: { siteId: parsedSiteId },
        });
        const blockedStage = findCompletedStageInRequest(
          stageMaterial,
          requestStageWiseQty,
        );
        if (blockedStage) {
          return this.sendResponse(req, res, {
            status: 400,
            message: `Cannot create material requests for completed stage: ${blockedStage}`,
          });
        }
      }

      const steelSizeValue = toFloat(steel_size ?? steelSize);
      const steelLengthValue = toFloat(steel_length ?? steelLength);
      const steelItemsInput = Array.isArray(steel_items)
        ? steel_items
        : Array.isArray(steelItems)
          ? steelItems
          : [];
      const normalizedSteelItems = normalizeSteelItemsPayload(steelItemsInput);
      const isSteelProduct = String(productExists?.name || "")
        .toLowerCase()
        .includes("steel");
      const isSanitaryProduct = String(productExists?.name || "")
        .toLowerCase()
        .includes("sanitary");
      const incomingSanitaryImage =
        sanitary_image && typeof sanitary_image === "object"
          ? sanitary_image
          : sanitaryImage && typeof sanitaryImage === "object"
            ? sanitaryImage
            : null;
      const computedSteelItemsQty = normalizedSteelItems.reduce((sum, item) => {
        return sum + (toFloat(item?.totalKg) || 0);
      }, 0);
      const steelSizeFactor = STEEL_SIZE_FACTOR[steelSizeValue] || 0;
      const computedSteelQty =
        isSteelProduct &&
        computedSteelItemsQty > 0
          ? roundSteelQty(computedSteelItemsQty)
          : isSteelProduct &&
            Number.isFinite(steelSizeValue) &&
            Number.isFinite(steelLengthValue) &&
            steelSizeFactor > 0 &&
            steelSizeValue > 0 &&
            steelLengthValue > 0
            ? roundSteelQty(steelSizeFactor * steelLengthValue)
          : null;
      if (isSanitaryProduct && !incomingSanitaryImage) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "Sanitary request requires an image",
        });
      }
      const finalQty = isSteelProduct
        ? Number.isFinite(computedSteelQty) && computedSteelQty > 0
          ? computedSteelQty
          : parsedQty
        : isSanitaryProduct
          ? parsedQty || 1
          : parsedQty;
      if (!Number.isFinite(finalQty) || finalQty <= 0) {
        return this.sendResponse(req, res, { status: 400, message: "qty must be greater than 0" });
      }

      const incomingStageRows = stagePayloadToRows(0, req.body, req?.user?.id);
      const primaryStageName =
        incomingStageRows[0]?.stageName || normalizeStageName(stageName);
      const resolvedStageWiseQty =
        stageWiseQty && typeof stageWiseQty === "object"
          ? stageWiseQty
          : stage_wise_qty && typeof stage_wise_qty === "object"
            ? stage_wise_qty
            : null;

      const newRequest = await prisma.$transaction(async (tx) => {
        const lastRequest = await tx.request.findFirst({
          where: { siteId: parsedSiteId },
          orderBy: { siteRequestId: "desc" },
          select: { siteRequestId: true },
        });
        const nextSiteRequestId = lastRequest ? lastRequest.siteRequestId + 1 : 1;

        const created = await tx.request.create({
          data: {
            stageName: primaryStageName,
            siteRequestId: nextSiteRequestId,
            productId: parsedProductId,
            qty: finalQty,
            stageWiseQty: resolvedStageWiseQty,
            steelItes: normalizedSteelItems,
            sanitaryImage: incomingSanitaryImage,
            priority: normalizedPriority,
            releasedQty: toFloat(releasedQty ?? released_qty),
            receivedQty: toFloat(receivedQty ?? received_qty),
            status: normalizeStatus(status),
            siteId: parsedSiteId,
          },
        });

        const stageRows = incomingStageRows.map((row) => ({
          ...row,
          requestId: created.id,
        }));
        const safeStageRows =
          stageRows.length > 0
            ? stageRows
            : [
                {
                  requestId: created.id,
                  stageName: normalizeStageName("SUPERVISOR"),
                  status: "PENDING",
                  comment: null,
                  userId: Number(req?.user?.id || 0) || 1,
                  stageImageId: null,
                  receivedAt: null,
                  forwardAt: new Date(),
                },
              ];
        await tx.requestStage.createMany({ data: safeStageRows });
        return created;
      });

      const hydrated = await prisma.request.findUnique({
        where: { id: newRequest.id },
        include: { site: true, stages: { include: { user: { select: { id: true, name: true, role: true } } } }, product: true },
      });
      const serialized = serializeRequest(hydrated);

      return this.sendResponse(req, res, {
        status: 201,
        message: "Request created successfully",
        data: serialized,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to create request",
        error: error.message,
      });
    }
  };

  getRequests = async (req, res) => {
    try {
      const requests = await prisma.request.findMany({
        include: { site: true, stages: { include: { user: { select: { id: true, name: true, role: true } } } }, product: true },
        orderBy: { createdAt: "desc" },
      });
      return this.sendResponse(req, res, { status: 200, data: requests.map(serializeRequest) });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Could not retrieve requests",
        error: error.message,
      });
    }
  };

  getRequestById = async (req, res) => {
    try {
      const id = Number(req.params.id);
      const siteIdFromQuery = req.query.siteId ? Number(req.query.siteId) : null;

      let request = null;
      if (Number.isFinite(siteIdFromQuery) && siteIdFromQuery > 0) {
        request = await prisma.request.findFirst({
          where: {
            siteId: siteIdFromQuery,
            OR: [{ id }, { siteRequestId: id }],
          },
          include: {
            site: true,
            stages: { include: { user: { select: { id: true, name: true, role: true } } } },
            product: true,
          },
        });
      } else {
        request = await prisma.request.findUnique({
          where: { id },
          include: {
            site: true,
            stages: { include: { user: { select: { id: true, name: true, role: true } } } },
            product: true,
          },
        });
      }

      if (!request) {
        return this.sendResponse(req, res, {
          status: 404,
          message: "Request not found",
        });
      }

      if (!(await this.ensureSiteAccess(req, res, request.siteId))) return;

      if (
        Number.isFinite(siteIdFromQuery) &&
        siteIdFromQuery > 0 &&
        request.siteId !== siteIdFromQuery
      ) {
        return this.sendResponse(req, res, {
          status: 403,
          message: "This material request does not belong to the requested site",
        });
      }

      return this.sendResponse(req, res, { status: 200, data: serializeRequest(request) });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Error retrieving request",
        error: error.message,
      });
    }
  };

  updateRequest = async (req, res) => {
    try {
      const requestId = Number(req.params.id);
      if (!Number.isFinite(requestId)) {
        return this.sendResponse(req, res, { status: 400, message: "Invalid request id" });
      }
      const existing = await prisma.request.findUnique({
        where: { id: requestId },
      });
      if (!existing) {
        return this.sendResponse(req, res, { status: 404, message: "Request not found" });
      }
      if (!(await this.ensureSiteAccess(req, res, existing.siteId))) return;
      const existingTotalMaterial = toFloat(existing?.qty) ?? 0;
      const existingReleasedQty = toFloat(existing?.releasedQty) ?? 0;
      const existingReceivedQty = toFloat(existing?.receivedQty) ?? 0;
      const existingUsedMaterial = existingReceivedQty > 0 ? existingReceivedQty : existingReleasedQty;
      const existingRemainingMaterial = Number(
        Math.max(existingTotalMaterial - existingUsedMaterial, 0).toFixed(6)
      );
      const isFinalApprovedStatusLocked =
        existing?.status === RequestStatus.APPROVED && existingRemainingMaterial <= 0;

      const data = {};
      if (req.body.productId !== undefined) {
        const parsedProductId = Number(req.body.productId);
        if (!Number.isFinite(parsedProductId)) {
          return this.sendResponse(req, res, { status: 400, message: "Invalid productId" });
        }
        data.productId = parsedProductId;
      }
      if (req.body.qty !== undefined) data.qty = toFloat(req.body.qty) ?? existing.qty;
      if (req.body.stageWiseQty !== undefined || req.body.stage_wise_qty !== undefined) {
        const payloadStageWiseQty =
          req.body.stageWiseQty && typeof req.body.stageWiseQty === "object"
            ? req.body.stageWiseQty
            : req.body.stage_wise_qty && typeof req.body.stage_wise_qty === "object"
              ? req.body.stage_wise_qty
              : null;
        data.stageWiseQty = payloadStageWiseQty;
      }
      if (req.body.steel_items !== undefined || req.body.steelItems !== undefined) {
        const payloadSteelItems = Array.isArray(req.body.steel_items)
          ? req.body.steel_items
          : Array.isArray(req.body.steelItems)
            ? req.body.steelItems
            : [];
        data.steelItes = normalizeSteelItemsPayload(payloadSteelItems);
      }
      if (req.body.sanitary_image !== undefined || req.body.sanitaryImage !== undefined) {
        const payloadSanitaryImage =
          req.body.sanitary_image && typeof req.body.sanitary_image === "object"
            ? req.body.sanitary_image
            : req.body.sanitaryImage && typeof req.body.sanitaryImage === "object"
              ? req.body.sanitaryImage
              : null;
        data.sanitaryImage = payloadSanitaryImage;
      }
      if (req.body.releasedQty !== undefined || req.body.released_qty !== undefined) {
        data.releasedQty = toFloat(req.body.releasedQty ?? req.body.released_qty);
      }
      if (req.body.receivedQty !== undefined || req.body.received_qty !== undefined) {
        data.receivedQty = toFloat(req.body.receivedQty ?? req.body.received_qty);
      }
      if (req.body.status !== undefined) {
        const requestedStatus = normalizeStatus(req.body.status);
        if (isFinalApprovedStatusLocked && requestedStatus !== existing?.status) {
          return this.sendResponse(req, res, {
            status: 400,
            message:
              "Status cannot be changed after request is approved and remaining material is zero",
          });
        }
        data.status = requestedStatus;
      }
      if (req.body.siteId !== undefined) {
        const parsedSiteId = Number(req.body.siteId);
        if (!Number.isFinite(parsedSiteId)) {
          return this.sendResponse(req, res, { status: 400, message: "Invalid siteId" });
        }
        data.siteId = parsedSiteId;
      }
      if (req.body.stageName !== undefined) {
        const parsedStageName = normalizeStageName(req.body.stageName);
        // Avoid wiping stageName with null when client sends arbitrary display values.
        if (parsedStageName) {
          data.stageName = parsedStageName;
        }
      }
      if (req.body.priority !== undefined) {
        const normalizedPriority = String(req.body.priority).toLowerCase();
        if (!VALID_PRIORITIES.includes(normalizedPriority)) {
          return this.sendResponse(req, res, { status: 400, message: "Invalid priority value" });
        }
        data.priority = normalizedPriority;
      }

      const stageRows = stagePayloadToRows(requestId, req.body, req?.user?.id);
      const receivedQtyForStage =
        toFloat(req.body.receivedQty ?? req.body.received_qty) ??
        toFloat(existing.receivedQty) ??
        0;
      const releasedQtyForStage =
        toFloat(req.body.releasedQty ?? req.body.released_qty) ??
        toFloat(existing.releasedQty) ??
        0;
      const shouldUpsertReceivingStage =
        receivedQtyForStage > 0 &&
        releasedQtyForStage > 0 &&
        receivedQtyForStage >= releasedQtyForStage;
      const receivingStageName = normalizeStageName("RECEIVING");
      if (shouldUpsertReceivingStage && receivingStageName) {
        const existingReceivingIndex = stageRows.findIndex(
          (row) => row.stageName === receivingStageName
        );
        if (existingReceivingIndex >= 0) {
          // Preserve user-entered fields (comment, stage image) and only enforce approval timestamps.
          stageRows[existingReceivingIndex] = {
            ...stageRows[existingReceivingIndex],
            status: "APPROVED",
            receivedAt: stageRows[existingReceivingIndex].receivedAt || new Date(),
            forwardAt: stageRows[existingReceivingIndex].forwardAt || new Date(),
          };
        } else {
          stageRows.push({
            requestId,
            stageName: receivingStageName,
            status: "APPROVED",
            comment: null,
            userId: Number(req?.user?.id || existing?.updated_by || 0) || 1,
            receivedAt: new Date(),
            forwardAt: new Date(),
          });
        }
      } else if (shouldUpsertReceivingStage && !receivingStageName) {
        console.warn(
          "[Request.updateRequest] RECEIVING stage skipped: StageName enum does not include RECEIVING."
        );
      }

      // Keep only one upsert row per stage to avoid duplicate writes.
      const dedupedStageRows = Array.from(
        stageRows.reduce((acc, row) => acc.set(row.stageName, row), new Map()).values()
      );

      const updatedRequest = await prisma.$transaction(
        async (tx) => {
          await tx.request.update({
            where: { id: requestId },
            data,
          });

          if (dedupedStageRows.length) {
            // Run transaction queries sequentially to avoid invalidating
            // Prisma interactive transaction context in production.
            for (const row of dedupedStageRows) {
              await tx.requestStage.upsert({
                where: {
                  requestId_stageName: {
                    requestId,
                    stageName: row.stageName,
                  },
                },
                create: row,
                update: {
                  status: row.status,
                  comment: row.comment,
                  userId: row.userId,
                  stageImageId: row.stageImageId,
                  receivedAt: row.receivedAt,
                  forwardAt: row.forwardAt,
                },
              });
            }
          }

          const hydrated = await tx.request.findUnique({
            where: { id: requestId },
            include: {
              site: true,
              stages: { include: { user: { select: { id: true, name: true, role: true } } } },
              product: true,
            },
          });
          const derivedStatus = deriveRequestStatus(hydrated, hydrated.stages);
          if (isFinalApprovedStatusLocked) {
            hydrated.status = existing.status;
          } else if (derivedStatus !== hydrated.status) {
            await tx.request.update({
              where: { id: requestId },
              data: { status: derivedStatus },
            });
            hydrated.status = derivedStatus;
          }
          return hydrated;
        },
        {
          // Production DB/network can be slower than local defaults.
          // Increase interactive transaction window to prevent premature close.
          maxWait: 10000,
          timeout: 20000,
        }
      );

      const serialized = serializeRequest(updatedRequest);
      this.sendResponse(req, res, {
        status: 200,
        message: "Request updated",
        data: serialized,
      });
      // Recalculate stage/material totals in background so request approval
      // response is not blocked by heavy aggregation work.
      recalculateSiteStageUsage(updatedRequest.siteId).catch((recalcError) => {
        console.error(
          `[Request.updateRequest] recalculateSiteStageUsage failed for site ${updatedRequest.siteId}:`,
          recalcError
        );
      });
      return;
    } catch (error) {
      console.error("Request update failed:", error);
      return this.sendResponse(req, res, {
        status: 400,
        message: `Update failed: ${error.message}`,
      });
    }
  };

  deleteRequest = async (req, res) => {
    try {
      const requestId = Number(req.params.id);
      if (!Number.isFinite(requestId) || requestId <= 0) {
        return this.sendResponse(req, res, { status: 400, message: "Invalid request id" });
      }
      const existing = await prisma.request.findUnique({ where: { id: requestId } });
      if (!existing) {
        return this.sendResponse(req, res, { status: 404, message: "Request not found" });
      }
      if (!(await this.ensureSiteAccess(req, res, existing.siteId))) return;
      await prisma.requestStage.deleteMany({ where: { requestId } });
      await prisma.request.delete({ where: { id: requestId } });
      return this.sendResponse(req, res, { status: 200, message: "Request deleted" });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Deletion failed",
        error: error.message,
      });
    }
  };

  getRequestBySiteId = async (req, res) => {
    try {
      const siteId = Number(req.params.siteId);
      if (!(await this.ensureSiteAccess(req, res, siteId))) return;
      const requests = await prisma.request.findMany({
        where: { siteId },
        include: { site: true, stages: { include: { user: { select: { id: true, name: true, role: true } } } }, product: true },
        orderBy: { createdAt: "desc" },
      });
      return this.sendResponse(req, res, { status: 200, data: requests.map(serializeRequest) });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Error fetching requests for site",
        error: error.message,
      });
    }
  };

  getRequestsByStageNameFromBody = async (req, res) => {
    try {
      const stageName = normalizeStageName(req.body.stageName);
      const siteId = req.body.siteId ? Number(req.body.siteId) : null;
      if (siteId && !(await this.ensureSiteAccess(req, res, siteId))) return;
      const where = { ...(siteId ? { siteId } : {}) };

      // If stageName matches enum, filter by stage.
      // If custom stage name is sent from frontend, fallback to site-level list
      // so request listing does not disappear.
      if (stageName) {
        where.OR = [
          { stages: { some: { stageName } } },
          { stageName },
        ];
      }

      const requests = await prisma.request.findMany({
        where,
        include: { site: true, stages: { include: { user: { select: { id: true, name: true, role: true } } } }, product: true },
        orderBy: { createdAt: "desc" },
      });
      return this.sendResponse(req, res, { status: 200, data: requests.map(serializeRequest) });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 500,
        message: "Error fetching requests",
        error: error.message,
      });
    }
  };
}

module.exports = Requests;
module.exports.recalculateSiteStageUsage = recalculateSiteStageUsage;
