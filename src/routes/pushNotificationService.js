const PushNotificationService = require("../handlers/PushNotificationService");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new PushNotificationService();
router.get("/last-notification/:userId", authenticateJWT, handler.getLastNotifications);
router.get("/notification-length/:userId", authenticateJWT, handler.getLengthNotificationByUserId);
router.post("/save-subscription", authenticateJWT, handler.saveSubscription);
router.post("/check-subscription", authenticateJWT, handler.checkSubscription);
router.post("/clear-user-notifications", authenticateJWT, handler.clearSubscription);
router.post("/user-notifications", authenticateJWT, handler.sendNotificationToUserUploadFile);
router.post("/messages-notifications", authenticateJWT, handler.sendNotificationOnSendMessage);
router.post("/site-create", authenticateJWT, handler.sendNotificationToUserCreateSite);
router.post("/request-create", authenticateJWT, handler.sendNotificationOnMaterialRequest);
router.post("/stage", authenticateJWT, handler.sendNotificationOnStageAdd);
router.put("/mark-read/:notificationId", authenticateJWT, handler.markNotificationAsRead);
router.put("/mark-all-read/:userId", authenticateJWT, handler.markAllNotificationsAsRead);
router.delete("/clear-all/:userId", authenticateJWT, handler.clearAllNotifications);
router.get("/:userId", authenticateJWT, handler.getNotificationsByUserId);


module.exports = router;
