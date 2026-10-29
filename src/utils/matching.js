'use strict';

/**
 * Mencocokkan invoice PENDING dengan transaksi masuk dari provider.
 * Syarat: transaksi sukses, nominal sama persis dengan payable_amount, waktu di antara
 * (pembuatan invoice - toleransi) dan kedaluwarsa, dan satu transaksi hanya untuk satu invoice.
 * Invoice diproses dari yang paling lama agar adil.
 */
function matchPending(pending, txs, { skewMs = 60000 } = {}) {
  const used = new Set();
  const matches = [];
  const ordered = [...pending].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const invoice of ordered) {
    const from = new Date(invoice.created_at).getTime() - skewMs;
    const until = new Date(invoice.expires_at).getTime();
    const amount = Number(invoice.payable_amount);

    const tx = txs.find(
      (t) =>
        !used.has(t.id) &&
        t.success &&
        t.amount === amount &&
        t.time &&
        t.time.getTime() >= from &&
        t.time.getTime() <= until
    );
    if (tx) {
      used.add(tx.id);
      matches.push({ invoice, tx });
    }
  }
  return matches;
}

module.exports = { matchPending };
