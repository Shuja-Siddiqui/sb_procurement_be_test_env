const { DailyUpdate } = require("../handlers");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new DailyUpdate();

router.post("/", authenticateJWT, handler.upsertBySiteDate);
router.post("/issues", authenticateJWT, handler.upsertIssuesBySiteDate);
router.get("/issues/:siteId/history", authenticateJWT, handler.getIssuesHistoryBySite);
router.get("/issues/:siteId", authenticateJWT, handler.getIssuesBySiteDate);
router.post("/site-progress", authenticateJWT, handler.upsertSiteProgressBySiteDate);
router.get("/site-progress/:siteId/history", authenticateJWT, handler.getSiteProgressHistoryBySite);
router.get("/site-progress/:siteId", authenticateJWT, handler.getSiteProgressBySiteDate);
router.get("/:siteId/history", authenticateJWT, handler.getHistoryBySite);
router.get("/:siteId", authenticateJWT, handler.getBySiteDate);

module.exports = router;
