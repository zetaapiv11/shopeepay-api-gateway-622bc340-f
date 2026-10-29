'use strict';

const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const apiKey = require('../middleware/apiKey');
const provider = require('../services/paymentProvider');
const invoices = require('../services/invoices');
const telegram = require('../services/telegram');
const watcher = require('../services/watcher');
const callbacks = require('../services/callbacks');
const { ProviderError } = provider;
const { AppError, asyncHandler } = require('../utils/errors');
const { validateAmount, validateOrderId, validateUuid } = require('../utils/validate');

const router = express.Router();
const lastCheck = new Map();

function baseUrl(req) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

function paidResponse(inv) {
  const data = invoices.serialize(inv);
  return {
    success: true,
    paid: true,
    status: 'PAID',
    order_id: inv.order_id,
    transaction: { transaction_id: inv.provider_txn_id, amount: Number(inv.payable_amount), paid_at: inv.paid_at },
    data,
  };
}

router.post(
  '/create-qris',
  apiKey,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const amount = validateAmount(body.amount);
    const orderId = validateOrderId(body.order_id);

    if (!provider.capabilities().canCreateInvoice) {
      throw new ProviderError('NOT_CONFIGURED', 'QRIS_STATIC belum dikonfigurasi, pembuatan QRIS dinonaktifkan.', 501);
    }

    await invoices.expireStale();

    const attempts = config.uniqueCodeMax > 0 ? 8 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const uniqueCode = config.uniqueCodeMax > 0 ? 1 + crypto.randomInt(config.uniqueCodeMax) : 0;
      const payable = amount + uniqueCode;
      const issued = await provider.createInvoice({ amount: payable, orderId });

      let row;
      try {
        row = await invoices.insert({
          orderId,
          amount,
          uniqueCode,
          payableAmount: payable,
          provider: provider.capabilities().provider,
          providerInvoiceId: issued.providerInvoiceId,
          qrisPayload: issued.qrisPayload,
          qrisKind: issued.qrisKind,
          expiresAt: issued.expiresAt,
        });
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'invoices_order_id_key') {
          throw new AppError(409, 'DUPLICATE_ORDER_ID', 'order_id sudah digunakan.');
        }
        if (err.code === '23505' && err.constraint === 'invoices_pending_payable_amount_uidx') {
          if (attempt < attempts - 1) continue;
          throw new AppError(
            409,
            'AMOUNT_IN_USE',
            'Masih ada invoice PENDING dengan nominal yang sama. Aktifkan UNIQUE_CODE_MAX atau gunakan nominal lain.'
          );
        }
        throw err;
      }

      telegram.notifyInvoiceCreated(row);
      return res.status(201).json({
        success: true,
        data: invoices.serialize(row, {
          includePayload: true,
          qrisUrl: `${baseUrl(req)}/qr/${row.id}`,
        }),
      });
    }
    throw new AppError(409, 'AMOUNT_IN_USE', 'Tidak dapat mengalokasikan nominal unik, coba lagi.');
  })
);

router.post(
  '/check-payment',
  apiKey,
  asyncHandler(async (req, res) => {
    const orderId = validateOrderId(req.body && req.body.order_id);

    await invoices.expireStale();
    const inv = await invoices.getByOrderId(orderId);
    if (!inv) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice tidak ditemukan.');

    if (inv.status === 'PAID') return res.json(paidResponse(inv));
    if (inv.status !== 'PENDING') {
      return res.json({ success: true, paid: false, status: inv.status, order_id: inv.order_id, data: invoices.serialize(inv) });
    }

    // Watcher otomatis sehat: cukup baca database, tidak perlu menembak provider lagi.
    if (watcher.isActive()) {
      return res.json({
        success: true,
        paid: false,
        status: 'PENDING',
        watched: true,
        order_id: inv.order_id,
        data: invoices.serialize(inv),
      });
    }

    // Lindungi token dari polling berlebihan.
    const last = lastCheck.get(inv.id) || 0;
    if (Date.now() - last < config.minCheckIntervalMs) {
      return res.json({
        success: true,
        paid: false,
        status: 'PENDING',
        throttled: true,
        order_id: inv.order_id,
        data: invoices.serialize(inv),
      });
    }
    if (lastCheck.size > 5000) lastCheck.clear();
    lastCheck.set(inv.id, Date.now());

    const tokenHeader = req.get('x-shopee-token');
    const token = tokenHeader && tokenHeader.length >= 10 && tokenHeader.length <= 4000 && !/\s/.test(tokenHeader)
      ? tokenHeader
      : undefined;

    let status;
    try {
      status = await provider.getPaymentStatus({
        orderId,
        providerInvoiceId: inv.provider_invoice_id,
        invoice: inv,
        token,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.code !== 'NOT_CONFIGURED') {
        telegram.notifyIntegrationError(err.code, err.message);
      }
      throw err;
    }

    for (const match of status.matches) {
      const r = await invoices.markPaid(
        inv.id,
        { id: match.id, amount: match.amount, currency: match.currency },
        'poll',
        { issuer: match.issuer, provider_time: match.time }
      );
      if (r.result === 'PAID') {
        telegram.notifyPaymentVerified(r.invoice, { id: match.id, issuer: match.issuer });
        callbacks.kick();
        return res.json(paidResponse(r.invoice));
      }
      if (r.result === 'ALREADY_PAID') return res.json(paidResponse(r.invoice));
      if (r.result === 'TXN_ALREADY_CLAIMED') continue;
      break;
    }

    return res.json({ success: true, paid: false, status: 'PENDING', order_id: inv.order_id, data: invoices.serialize(inv) });
  })
);

// Publik: gambar QR untuk pelanggan. ID berupa UUID acak (tidak bisa ditebak).
router.get(
  '/qr/:id',
  asyncHandler(async (req, res) => {
    if (!validateUuid(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'QR tidak ditemukan.');
    const inv = await invoices.getById(req.params.id);
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'QR tidak ditemukan.');
    if (inv.status !== 'PENDING' || new Date(inv.expires_at) < new Date()) {
      throw new AppError(410, 'INVOICE_INACTIVE', 'Invoice sudah tidak aktif.');
    }
    const png = await QRCode.toBuffer(inv.qris_payload, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(png);
  })
);

module.exports = router;
