const { Requests } = require('../handlers');
const authenticateJWT = require('../middleware/auth');

const router = require('express').Router();
const handler = new Requests();

router.get('/sanitary-image/:id', authenticateJWT, handler.getSanitaryImage);
router.post('/upload-sanitary-image', authenticateJWT, handler.uploadSanitaryImage);
router.post('/',authenticateJWT, handler.createRequests);
router.get('/', authenticateJWT, handler.getRequests);
router.get('/:id', authenticateJWT, handler.getRequestById);
router.put('/:id', authenticateJWT, handler.updateRequest);
router.delete('/:id', authenticateJWT, handler.deleteRequest);
router.get('/site/:siteId',authenticateJWT, handler.getRequestBySiteId);
router.post("/by-stage", authenticateJWT, handler.getRequestsByStageNameFromBody);



module.exports = router;
