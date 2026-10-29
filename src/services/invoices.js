'use strict';

const db = require('../database/db');
const config = require('../config');

const LIST_COLUMNS = `id, order_id, amount, unique_code, payable_amount, currency, status,
  provider, provider_txn_id, qris_kind, expires_at, paid_at, created_at`;

async function expireStale() {
  const { rowCount } = await db.query(
    `UPDATE invoices SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'PENDING' AND expires_at < now()`
  );
  return rowCount;
}

// Menutup (EXPIRED) invoice PENDING yang nominal bayarnya sama, supaya QRIS baru bisa dibuat.
async function expirePendingByPayable(payableAmount) {
  const { rows } = await db.query(
    `UPDATE invoices SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'PENDING' AND payable_amount = $1
      RETURNING id`,
    [payableAmount]
  );
  for (const r of rows) {
    await db.query(
      `INSERT INTO payment_events (invoice_id, event_type, from_status, to_status, amount, source, details)
       VALUES ($1,'REPLACED','PENDING','EXPIRED',$2,'create-qris',$3)`,
      [r.id, payableAmount, JSON.stringify({ reason: 'digantikan QRIS baru dengan nominal sama' })]
    );
  }
  return rows.length;
}

async function insert(row) {
  const { rows } = await db.query(
    `INSERT INTO invoices
       (order_id, amount, unique_code, payable_amount, currency, status, provider,
        provider_invoice_id, qris_payload, qris_kind, expires_at)
     VALUES ($1,$2,$3,$4,'IDR','PENDING',$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      row.orderId,
      row.amount,
      row.uniqueCode,
      row.payableAmount,
      row.provider,
      row.providerInvoiceId,
      row.qrisPayload,
      row.qrisKind,
      row.expiresAt,
    ]
  );
  return rows[0];
}

async function getByOrderId(orderId) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE order_id = $1', [orderId]);
  return rows[0] || null;
}

async function getById(id) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Menandai invoice lunas secara atomik. Hanya dipanggil setelah pembayaran terverifikasi
 * (cocok dari mutasi provider atau webhook terverifikasi / simulasi development).
 *
 * Hasil: PAID | ALREADY_PAID | NOT_PENDING | MISMATCH | TXN_ALREADY_CLAIMED | NOT_FOUND
 */
async function markPaid(invoiceId, tx, source, details = {}) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    const inv = rows[0];
    if (!inv) return { result: 'NOT_FOUND' };
    if (inv.status === 'PAID') return { result: 'ALREADY_PAID', invoice: inv };
    if (inv.status !== 'PENDING') return { result: 'NOT_PENDING', invoice: inv };
    if (Number(inv.payable_amount) !== Number(tx.amount) || tx.currency !== inv.currency) {
      return { result: 'MISMATCH', invoice: inv };
    }

    await client.query('SAVEPOINT claim');
    let updated;
    try {
      const upd = await client.query(
        `UPDATE invoices
            SET status = 'PAID', provider_txn_id = $2, paid_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING *`,
        [invoiceId, tx.id]
      );
      updated = upd.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // provider_txn_id sudah dipakai invoice lain
        await client.query('ROLLBACK TO SAVEPOINT claim');
        return { result: 'TXN_ALREADY_CLAIMED', invoice: inv };
      }
      throw err;
    }

    await client.query(
      `INSERT INTO payment_events
         (invoice_id, event_type, from_status, to_status, amount, currency, provider_txn_id, source, event_key, details)
       VALUES ($1,'PAID','PENDING','PAID',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_key) DO NOTHING`,
      [invoiceId, tx.amount, tx.currency, tx.id, source, `PAID:${invoiceId}`, JSON.stringify(details)]
    );

    // Masukkan callback ke antrean di transaksi yang sama: lunas dan callback selalu konsisten.
    if (config.callbackUrl) {
      const payload = {
        event: 'payment.paid',
        event_id: `evt_${invoiceId}`,
        order_id: updated.order_id,
        invoice_id: updated.id,
        amount: Number(updated.amount),
        payable_amount: Number(updated.payable_amount),
        currency: updated.currency,
        status: 'PAID',
        transaction_id: tx.id,
        paid_at: updated.paid_at,
        source,
      };
      await client.query(
        `INSERT INTO callback_deliveries (invoice_id, event_type, payload)
         VALUES ($1,'payment.paid',$2)
         ON CONFLICT (invoice_id, event_type) DO NOTHING`,
        [invoiceId, JSON.stringify(payload)]
      );
    }
    return { result: 'PAID', invoice: updated };
  });
}

async function listPending(limit = 200) {
  const { rows } = await db.query(
    `SELECT id, order_id, payable_amount, created_at, expires_at
       FROM invoices
      WHERE status = 'PENDING' AND expires_at >= now()
      ORDER BY created_at
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function list({ status, orderId, from, to, page, limit }) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (orderId) {
    params.push(orderId);
    where.push(`order_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at < $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totals = await db.query(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(payable_amount) FILTER (WHERE status = 'PAID'), 0)::bigint AS paid_total
       FROM invoices ${clause}`,
    params
  );

  const pageParams = [...params, limit, (page - 1) * limit];
  const rows = await db.query(
    `SELECT ${LIST_COLUMNS} FROM invoices ${clause}
      ORDER BY created_at DESC, id
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams
  );

  return {
    items: rows.rows,
    total: totals.rows[0].total,
    totalPaidAmount: Number(totals.rows[0].paid_total),
  };
}

function serialize(row, { includePayload = false, qrisUrl = null } = {}) {
  const out = {
    invoice_id: row.id,
    order_id: row.order_id,
    amount: Number(row.amount),
    unique_code: row.unique_code,
    payable_amount: Number(row.payable_amount),
    currency: row.currency,
    status: row.status,
    qris_kind: row.qris_kind,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
  if (row.provider_txn_id) out.provider_txn_id = row.provider_txn_id;
  if (qrisUrl) out.qris_url = qrisUrl;
  if (includePayload) out.qris_payload = row.qris_payload;
  return out;
}

module.exports = { expireStale, expirePendingByPayable, insert, getByOrderId, getById, markPaid, listPending, list, serialize };
