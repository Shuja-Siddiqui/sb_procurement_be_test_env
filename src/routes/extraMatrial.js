const ExtraMaterial = require("../handlers/ExtraMatrial");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new ExtraMaterial();

router.get("/:siteId", authenticateJWT, handler.getExtraMaterialsBySite);

module.exports = router;
