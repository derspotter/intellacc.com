const express = require('express');
const router = express.Router();
const controller = require('../controllers/deviceController');
const authenticateJWT = require('../middleware/auth');

router.get('/', authenticateJWT, controller.listDevices);
router.post('/register', authenticateJWT, controller.registerDevice);
router.delete('/:id', authenticateJWT, controller.revokeDevice);

router.post('/link/start', authenticateJWT, controller.startLinking);
router.post('/link/approve', authenticateJWT, controller.approveLinking);
router.get('/link/status', authenticateJWT, controller.checkLinkingStatus);

module.exports = router;
