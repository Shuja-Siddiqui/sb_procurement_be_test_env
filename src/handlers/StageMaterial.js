const Response = require("./Response");
const prisma = require("../lib/prisma");
class StageMaterial extends Response {

  createOrUpdate = async (req, res) => {
    try {
      const { siteId, data } = req.body;
      if (!siteId || !data) {
        return res.status(400).json({
          message: "siteId and data are required",
          status: 400,
        });
      }

      // 1) Check site exists
      const site = await prisma.site.findUnique({ where: { id: siteId } });
      if (!site) {
        return res.status(404).json({ message: "Site not found", status: 404 });
      }

      // Helper: merge duplicate productIds inside stage.items
      const mergeStageItems = (items) => {
        const map = {};
        for (const it of items) {
          const pid = it.productId;
          if (!map[pid]) {
            map[pid] = { ...it };
            map[pid].qty = parseFloat(it.qty) || 0;
            map[pid].used_qty = parseFloat(it.used_qty) || 0;
            map[pid].purchase_qty = parseFloat(it.purchase_qty) || 0;
            map[pid].amount = parseFloat(it.amount) || 0;
          } else {
            map[pid].qty += parseFloat(it.qty) || 0;
            map[pid].used_qty += parseFloat(it.used_qty) || 0;
            map[pid].purchase_qty += parseFloat(it.purchase_qty) || 0;
            map[pid].amount += parseFloat(it.amount) || 0;
          }
        }
        return Object.values(map);
      };

      // 2) Pre-process: consume extraMaterial + merge duplicates
      for (const stageKey of Object.keys(data)) {
        const stage = data[stageKey];
        if (stage?.stageNumber != null && stage.stageNumber !== "") {
          const parsed = Number.parseInt(String(stage.stageNumber), 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            stage.stageNumber = parsed;
          } else {
            delete stage.stageNumber;
          }
        }
        const items = stage.items || [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const productId = item.productId;

          // Check if product exists in extraMaterial
          const existingExtra = await prisma.extraMaterial.findFirst({
            where: { siteId, productId },
          });

          if (existingExtra) {
            item.purchase_qty = existingExtra.purchase_qty || 0;
            item.rate = existingExtra.rate || item.rate || 0;
            item.amount = existingExtra.amount || item.amount || 0;

            // Remove from extraMaterial (since consumed)
            await prisma.extraMaterial.delete({
              where: { id: existingExtra.id },
            });
          }
        }

        // Merge duplicates inside the stage
        stage.items = mergeStageItems(items);

        if (!Array.isArray(stage.extraMaterial)) {
          stage.extraMaterial = [];
        }
      }

      // 3) Save stageMaterial (update if exists, create otherwise)
      const existingStageMaterial = await prisma.stageMaterial.findUnique({
        where: { siteId },
      });

      let stageResult;
      if (existingStageMaterial) {
        stageResult = await prisma.stageMaterial.update({
          where: { siteId },
          data: { data },
        });
      } else {
        const stageNames = Object.keys(data);
        const firstStageName = stageNames.length > 0 ? stageNames[0] : null;

        stageResult = await prisma.stageMaterial.create({
          data: { siteId, data },
        });

        // Set currentStage only if first time
        if (firstStageName) {
          await prisma.site.update({
            where: { id: siteId },
            data: { currentStage: firstStageName },
          });
        }
      }

      // 4) Recompute materialTotal from saved stageMaterial
      const materialTotalsMap = {};
      for (const stageKey of Object.keys(stageResult.data || {})) {
        const stage = stageResult.data[stageKey] || {};
        const items = stage.items || [];

        for (const it of items) {
          const productId = it.productId;
          const qty = parseFloat(it.qty) || 0;
          const usedQty = parseFloat(it.used_qty) || 0;
          const purchase_qty = parseFloat(it.purchase_qty) || 0;
          const amount = parseFloat(it.amount) || 0;

          if (!materialTotalsMap[productId]) {
            materialTotalsMap[productId] = {
              productId,
              quantity: 0,
              used_qty: 0,
              rate: it.rate || 0,
              purchase_qty: 0,
              amount: 0,
            };
          }

          // Add totals
          materialTotalsMap[productId].quantity = parseFloat(
            (materialTotalsMap[productId].quantity + qty).toFixed(6)
          );
          materialTotalsMap[productId].used_qty = parseFloat(
            (materialTotalsMap[productId].used_qty + usedQty).toFixed(6)
          );
          materialTotalsMap[productId].purchase_qty = parseFloat(
            (materialTotalsMap[productId].purchase_qty + purchase_qty).toFixed(6)
          );
          materialTotalsMap[productId].amount = parseFloat(
            (materialTotalsMap[productId].amount + amount).toFixed(6)
          );

          if (it.rate !== undefined) {
            materialTotalsMap[productId].rate = it.rate;
          }
        }
      }

      const formattedData = Object.values(materialTotalsMap).map((item) => ({
        productId: item.productId,
        quantity: parseFloat((item.quantity || 0).toFixed(6)),
        used_qty: parseFloat((item.used_qty || 0).toFixed(6)),
        rate: item.rate || 0,
        purchase_qty: parseFloat((item.purchase_qty || 0).toFixed(6)),
        amount: parseFloat((item.amount || 0).toFixed(6)),
      }));

      // 5) Save materialTotal
      await prisma.materialTotal.upsert({
        where: { siteId },
        update: { data: formattedData },
        create: { siteId, data: formattedData },
      });

      return res.status(200).json({
        message:
          "Stage material saved, duplicates merged, material total updated, extra material consumed",
        status: 200,
        data: stageResult,
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
      const material = await prisma.stageMaterial.findUnique({
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
      const siteId = Number(req.params.id);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return this.sendResponse(req, res, {
          message: "Valid siteId is required",
          status: 400,
        });
      }
      await prisma.stageMaterial.delete({
        where: { siteId },
      });

      return this.sendResponse(req, res, {
        message: "Stage material deleted successfully",
        status: 200,
      });
    } catch (error) {
      console.error(error);
      return this.sendResponse(req, res, {
        message: "Failed to delete stage material",
        status: 500,
      });
    }
  };
}

module.exports = StageMaterial;
