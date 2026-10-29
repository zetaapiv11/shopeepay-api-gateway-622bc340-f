'use strict';

const express = require('express');
const apiKey = require('../middleware/apiKey');
const config = require('../config');
const provider = require('../services/paymentProvider');
const watcher = require('../services/watcher');
const callbacks = require('../services/callbacks');
const { AppError, asyncHandler } = require('../utils/errors');

const router = express.Router();

function readTokenOverride(req) {
  const t = req.get('x-shopee-token');
  if (!t) return undefined;
  if (t.length < 10 || t.length > 4000 || /\s/.test(t)) {
    throw new AppError(400, 'INVALID_TOKEN', 'Format X-Shopee-Token tidak valid.');
  }
  return t;
}

// NOT_CONFIGURED | UNVERIFIED | VALID | INVALID  (berdasarkan bukti uji langsung ke provider)
router.get(
  '/token-status',
  apiKey,
  asyncHandler(async (req, res) => {
    const result = await provider.validateCredentials({ token: readTokenOverride(req) });
    res.json({
      success: true,
      data: {
        token_status: result.state,
        message: result.message,
        checked_at: result.checkedAt,
        capabilities: provider.capabilities(),
        watcher: { enabled: config.watchIntervalSeconds > 0, active: watcher.isActive() },
        callback_configured: callbacks.enabled(),
      },
    });
  })
);

// Mengganti token sesi di memori proses (tidak disimpan ke disk/DB, hilang saat restart).
router.post(
  '/update-token',
  apiKey,
  asyncHandler(async (req, res) => {
    const token = req.body && req.body.token;
    if (typeof token !== 'string' || token.length < 10 || token.length > 4000 || /\s/.test(token)) {
      throw new AppError(400, 'INVALID_TOKEN', 'token harus berupa string tanpa spasi (10-4000 karakter).');
    }
    provider.setToken(token);
    res.json({
      success: true,
      message: 'Token diperbarui di memori. Panggil GET /token-status untuk menguji.',
    });
  })
);

module.exports = router;
