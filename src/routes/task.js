const Task = require("../handlers/Task");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new Task();

router.post("/", authenticateJWT, handler.create);
router.get("/", authenticateJWT, handler.getAll);
router.get("/:id/logs", authenticateJWT, handler.getLogs);
router.get("/:id", authenticateJWT, handler.getById);
router.put("/:id", authenticateJWT, handler.update);
router.patch("/:id/status", authenticateJWT, handler.updateStatus);
router.delete("/:id", authenticateJWT, handler.delete);

module.exports = router;
