'use strict';

const express = require('express');
const apiKey = require('../middleware/apiKey');
const invoices = require('../services/invoices');
const provider = require('../services/paymentProvider');
const { asyncHandler } = require('../utils/errors');
const { validateOrderId, parsePagination, parseStatus, parseDateParam } = require('../utils/validate');

const router = express.Router();

const LOCAL_NOTE =
  'Data ini adalah transaksi LOKAL yang dicatat gateway di PostgreSQL. ' +
  'Bukan seluruh mutasi merchant ShopeePay; gunakan GET /transactions/provider untuk membaca mutasi dari provider (bila dikonfigurasi).';

router.use(apiKey);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const status = parseStatus(req.query.status);
    const orderId = req.query.order_id ? validateOrderId(req.query.order_id) : null;

    const r = await invoices.list({ status, orderId, page, limit });
    res.json({
      success: true,
      note: LOCAL_NOTE,
      data: {
        transactions: r.items.map((row) => invoices.serialize(row)),
        page,
        limit,
        total: r.total,
        total_pages: Math.ceil(r.total / limit),
      },
    });
  })
);

router.get(
  '/all',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const status = parseStatus(req.query.status);
    const from = parseDateParam(req.query.start_date, 'start_date');
    const to = parseDateParam(req.query.end_date, 'end_date', { isEnd: true });

    const r = await invoices.list({ status, from, to, page, limit });
    res.json({
      success: true,
      note: LOCAL_NOTE,
      data: {
        transactions: r.items.map((row) => invoices.serialize(row)),
        page,
        limit,
        total: r.total,
        total_pages: Math.ceil(r.total / limit),
        total_paid_amount: r.totalPaidAmount,
      },
    });
  })
);

// Mutasi dari provider (tidak resmi, butuh SHOPEE_TOKEN + SHOPEE_API_BASE).
router.get(
  '/provider',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const startDate = parseDateParam(req.query.start_date, 'start_date') || undefined;
    const endDate = parseDateParam(req.query.end_date, 'end_date', { isEnd: true }) || undefined;
    const list = await provider.getTransactions({ page, limit, startDate, endDate });
    res.json({
      success: true,
      data: {
        transactions: list.map((t) => ({
          transaction_id: t.id,
          amount: t.amount,
          status: t.status,
          time: t.time,
          issuer: t.issuer,
        })),
        page,
        limit,
      },
    });
  })
);

module.exports = router;
