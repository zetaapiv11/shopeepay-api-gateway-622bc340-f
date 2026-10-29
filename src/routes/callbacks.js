'use strict';

const express = require('express');
const apiKey = require('../middleware/apiKey');
const callbacks = require('../services/callbacks');
const { AppError, asyncHandler } = require('../utils/errors');
const { validateOrderId, parsePagination } = require('../utils/validate');

const router = express.Router();
router.use(apiKey);

// Daftar antrean callback. Pantau status=FAILED: itu pelanggan yang sudah bayar tetapi website belum menerima kabar.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    if (status && !['PENDING', 'DELIVERED', 'FAILED'].includes(status)) {
      throw new AppError(400, 'INVALID_STATUS', 'status harus PENDING, DELIVERED, atau FAILED.');
    }
    const r = await callbacks.list({ status, page, limit });
    res.json({
      success: true,
      data: { callbacks: r.items, page, limit, total: r.total, enabled: callbacks.enabled() },
    });
  })
);

router.post(
  '/retry',
  asyncHandler(async (req, res) => {
    const orderId = validateOrderId(req.body && req.body.order_id);
    const n = await callbacks.retry(orderId);
    if (n === 0) throw new AppError(404, 'CALLBACK_NOT_FOUND', 'Tidak ada callback PENDING/FAILED untuk order ini.');
    res.json({ success: true, message: 'Callback dijadwalkan ulang.' });
  })
);

module.exports = router;
