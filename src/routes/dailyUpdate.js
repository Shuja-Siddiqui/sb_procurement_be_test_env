const { DailyUpdate } = require("../handlers");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new DailyUpdate();

router.post("/", authenticateJWT, handler.upsertBySiteDate);
router.post("/issues", authenticateJWT, handler.upsertIssuesBySiteDate);
router.get("/issues/history", authenticateJWT, handler.getAllIssuesHistory);
router.get("/issues/:siteId/history", authenticateJWT, handler.getIssuesHistoryBySite);
router.get("/issues/:siteId", authenticateJWT, handler.getIssuesBySiteDate);
router.post("/site-progress", authenticateJWT, handler.upsertSiteProgressBySiteDate);
router.get("/site-progress/history", authenticateJWT, handler.getAllSiteProgressHistory);
router.get("/site-progress/:siteId/history", authenticateJWT, handler.getSiteProgressHistoryBySite);
router.get("/site-progress/:siteId", authenticateJWT, handler.getSiteProgressBySiteDate);
router.post("/photos", authenticateJWT, handler.uploadPhotos);
router.get("/photos/file/:id", authenticateJWT, handler.getPhotoFile);
router.get("/photos/gallery", authenticateJWT, handler.getPhotosGallery);
router.get("/photos/site/:siteId", authenticateJWT, handler.getPhotosBySite);
router.patch("/photos/:id/note", authenticateJWT, handler.updatePhotoCaption);
router.delete("/photos/:id", authenticateJWT, handler.deletePhoto);
router.get("/photos/:siteId", authenticateJWT, handler.getPhotosBySiteDate);
router.get("/:siteId/history", authenticateJWT, handler.getHistoryBySite);
router.get("/:siteId", authenticateJWT, handler.getBySiteDate);

module.exports = router;
