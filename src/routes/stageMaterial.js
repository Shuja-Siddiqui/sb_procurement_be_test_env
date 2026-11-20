const { StageMaterial } = require("../handlers");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new StageMaterial();

router.post("/", authenticateJWT, handler.createOrUpdate);
router.post("/bulk", authenticateJWT, handler.getBulkBySiteIds);
router.get("/:id", authenticateJWT, handler.getBySiteId);
router.delete("/:id", authenticateJWT, handler.deleteBySiteId);

module.exports = router;
