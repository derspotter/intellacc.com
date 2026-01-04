const express = require('express');
const router = express.Router();
const controller = require('../controllers/webauthnController');
const authenticateJWT = require('../middleware/auth');

// Registration (Authenticated)
router.post('/register/options', authenticateJWT, controller.generateRegistrationOptions);
router.post('/register/verify', authenticateJWT, controller.verifyRegistration);

// Authentication (Public - supports both usernameless and specified user)
router.post('/login/options', controller.generateAuthenticationOptions);
router.post('/login/verify', controller.verifyAuthentication);

// Credential Management (Authenticated)
router.get('/credentials', authenticateJWT, controller.getUserCredentials);
router.delete('/credentials/:id', authenticateJWT, controller.deleteCredential);

module.exports = router;