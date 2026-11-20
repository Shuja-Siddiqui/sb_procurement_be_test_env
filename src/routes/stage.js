const Stage = require("../handlers/Stage");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new Stage();

router.get("/plot-sizes", authenticateJWT, handler.listPlotSizes);
router.post("/plot-sizes", authenticateJWT, handler.createPlotSize);
router.put("/plot-sizes/:id", authenticateJWT, handler.updatePlotSize);
router.delete("/plot-sizes/:id", authenticateJWT, handler.deletePlotSize);

router.get("/", authenticateJWT, handler.listStages);
router.post("/", authenticateJWT, handler.createStage);
router.put("/:id", authenticateJWT, handler.updateStage);
router.delete("/:id", authenticateJWT, handler.deleteStage);
router.post("/:id/items", authenticateJWT, handler.addStageItem);
router.post("/:id/items/bulk", authenticateJWT, handler.addStageItemsBulk);
router.put("/:id/items/:itemId", authenticateJWT, handler.updateStageItem);
router.delete("/:id/items/:itemId", authenticateJWT, handler.deleteStageItem);

module.exports = router;
