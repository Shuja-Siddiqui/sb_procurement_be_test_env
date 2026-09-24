const ProductController = require("../handlers/Product");
const authenticateJWT = require("../middleware/auth");

const router = require("express").Router();
const handler = new ProductController();

router.post("/", authenticateJWT, handler.createProduct);
router.get("/", authenticateJWT, handler.getAllProducts);
router.delete("/:id", authenticateJWT, handler.deleteProduct);
router.put("/:id", authenticateJWT, handler.updateProduct);

module.exports = router;
