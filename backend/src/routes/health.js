// Health check route for API availability
const express = require('express');
const router = express.Router();

/**
 * Health check endpoint
 * @route GET /api/health-check
 * @returns {Object} 200 - Success response
 */
router.get('/health-check', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

module.exports = router;
