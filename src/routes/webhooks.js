'use strict';

const express = require('express');
const config = require('../config');
const db = require('../database/db');
const apiKey = require('../middleware/apiKey');
const provider = require('../services/paymentProvider');
const invoices = require('../services/invoices');
const telegram = require('../services/telegram');
const callbacks = require('../services/callbacks');
const { AppError, asyncHandler } = require('../utils/errors');
const { validateOrderId, validateEventId } = require('../utils/validate');

const router = express.Router();

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => mw(req, res, (err) => (err ? reject(err) : resolve())));
}

/**
 * POST /webhooks/payment
 *
 * Produksi: signature webhook ShopeePay belum terdokumentasi, jadi endpoint ini membalas
 * 501 NOT_CONFIGURED dan TIDAK menandai apa pun sebagai lunas.
 * Development: simulasi hanya jika NODE_ENV=development, header X-Dev-Simulation: true,
 * dan X-API-Key valid. Event simulasi ditandai simulated=true di database.
 */
router.post(
  '/payment',
  express.raw({ type: '*/*', limit: '100kb' }),
  asyncHandler(async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const verification = provider.verifyWebhook({ headers: req.headers, rawBody });
    let simulated = false;

    if (!verification.configured) {
      if (config.isDev && req.get('x-dev-simulation') === 'true') {
        await runMiddleware(apiKey, req, res);
        simulated = true;
      } else {
        throw new AppError(501, 'NOT_CONFIGURED', verification.reason);
      }
    } else if (!verification.valid) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Signature webhook tidak valid.');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      throw new AppError(400, 'INVALID_JSON', 'Body webhook harus JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError(400, 'INVALID_PAYLOAD', 'Payload webhook tidak valid.');
    }

    const eventId = validateEventId(payload.event_id);
    const orderId = validateOrderId(payload.order_id);
    const amount = payload.amount;
    const currency = payload.currency || 'IDR';
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'amount harus bilangan bulat positif.');
    }

    // Idempotensi: event_id yang sama hanya diproses sekali.
    const ins = await db.query(
      `INSERT INTO webhook_events (event_id, provider, signature_valid, simulated, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, provider.capabilities().provider, !simulated && verification.valid === true, simulated, JSON.stringify(payload)]
    );
    if (ins.rowCount === 0) {
      return res.json({ success: true, duplicate: true, message: 'Event sudah pernah diproses.' });
    }
    const webhookRowId = ins.rows[0].id;

    const finish = (result, invoiceId = null) =>
      db.query(
        'UPDATE webhook_events SET result = $2, invoice_id = $3, processed_at = now() WHERE id = $1',
        [webhookRowId, result, invoiceId]
      );

    const inv = await invoices.getByOrderId(orderId);
    if (!inv) {
      await finish('INVOICE_NOT_FOUND');
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice tidak ditemukan.');
    }

    const txId = simulated ? `SIM-${eventId}` : payload.transaction_id;
    if (typeof txId !== 'string' || !txId) {
      await finish('MISSING_TRANSACTION_ID', inv.id);
      throw new AppError(400, 'INVALID_TRANSACTION_ID', 'transaction_id diperlukan.');
    }

    const r = await invoices.markPaid(
      inv.id,
      { id: txId, amount, currency },
      simulated ? 'dev-simulation' : 'webhook',
      { event_id: eventId }
    );
    await finish(r.result, inv.id);

    if (r.result === 'PAID') {
      telegram.notifyPaymentVerified(r.invoice, { id: txId });
      callbacks.kick();
      return res.json({ success: true, result: 'PAID', simulated, data: invoices.serialize(r.invoice) });
    }
    if (r.result === 'ALREADY_PAID') {
      return res.json({ success: true, result: 'ALREADY_PAID', simulated, data: invoices.serialize(r.invoice) });
    }
    const status = r.result === 'MISMATCH' ? 422 : 409;
    throw new AppError(status, r.result, `Webhook tidak dapat diterapkan: ${r.result}.`);
  })
);

module.exports = router;
