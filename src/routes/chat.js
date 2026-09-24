const authenticateJWT = require("../middleware/auth");
const { Chat } = require("../handlers");
const router = require("express").Router();
const handler = new Chat();
router.post("/groups", authenticateJWT, handler.createGroup);
router.post("/groups/:id/join", authenticateJWT, handler.joinGroup);
router.get("/groups/:id/messages", authenticateJWT, handler.getMessages);
router.post("/groups/:id/messages", authenticateJWT, handler.sendMessage);
router.get("/groups/:id/members", authenticateJWT, handler.getGroupMembers);
router.get("/groups/:userId/", authenticateJWT, handler.getGroupsByUserId);
router.get("/audio/:id", authenticateJWT, handler.getAudioMessage);
router.get("/file/:id", authenticateJWT, handler.getFiles);
router.get("/groups/:id/media", authenticateJWT, handler.getGroupMedia);
router.patch("/groups/:groupId/seen", authenticateJWT, handler.getSeenByMessage);

module.exports = router;
