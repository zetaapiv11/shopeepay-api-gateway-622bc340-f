'use strict';

const express = require('express');

const router = express.Router();

// Publik. Tidak memuat token, API key, connection string, maupun kredensial lain.
router.get('/health', (req, res) => {
  res.json({ success: true, status: 'online', timestamp: new Date().toISOString() });
});

module.exports = router;
