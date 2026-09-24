const { File } = require('../handlers');
const authenticateJWT = require("../middleware/auth");

const router = require('express').Router();
const handler = new File();

router.get('/:id', authenticateJWT, handler.getFile);
router.post('/', authenticateJWT, handler.upload);

module.exports = router;
