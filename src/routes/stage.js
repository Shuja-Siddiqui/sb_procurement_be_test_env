const Stage = require("../handlers/Stage");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new Stage();

router.get("/", authenticateJWT, handler.listStages);
router.post("/", authenticateJWT, handler.createStage);
router.put("/:id", authenticateJWT, handler.updateStage);
router.post("/:id/items", authenticateJWT, handler.addStageItem);
router.post("/:id/items/bulk", authenticateJWT, handler.addStageItemsBulk);
router.delete("/:id/items/:itemId", authenticateJWT, handler.deleteStageItem);

module.exports = router;
