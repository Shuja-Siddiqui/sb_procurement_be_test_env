const { Users } = require('../handlers');
const authenticateJWT = require("../middleware/auth");

const router = require('express').Router();
const handler = new Users();

router.post('/', authenticateJWT, handler.createUser);
router.post('/login', handler.signIn);
router.get('/', authenticateJWT, handler.getUsers);
router.put('/me/password', authenticateJWT, handler.changeOwnPassword);
router.get('/:id', authenticateJWT, handler.getUserById);
router.put('/:id', authenticateJWT, handler.updateUser);
router.put("/:id/edit-status", authenticateJWT, handler.updateUserEditStatus);
router.delete('/:id', authenticateJWT, handler.deleteUser);

module.exports = router;
