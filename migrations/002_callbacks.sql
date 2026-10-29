-- 002_callbacks.sql : antrean callback keluar (website/bot) dengan retry

CREATE TABLE IF NOT EXISTS callback_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL DEFAULT 'payment.paid',
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  attempts         INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INTEGER,
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT callback_deliveries_invoice_event_key UNIQUE (invoice_id, event_type)
);

CREATE INDEX IF NOT EXISTS callback_deliveries_due_idx
  ON callback_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS callback_deliveries_status_idx
  ON callback_deliveries (status, created_at DESC);
