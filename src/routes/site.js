const { Sites } = require('../handlers');
const authenticateJWT = require("../middleware/auth");

const router = require('express').Router();
const handler = new Sites();

router.get("/site-names", authenticateJWT, handler.getSitesWithOnlyName);
router.get("/assignees", authenticateJWT, handler.getAssignableUsers);
router.post("/", authenticateJWT, handler.create);
router.get("/", authenticateJWT, handler.getAll);
router.get("/:id", authenticateJWT, handler.getById);
router.put("/:id", authenticateJWT, handler.update);
router.delete("/:id", authenticateJWT, handler.delete);

module.exports = router;
