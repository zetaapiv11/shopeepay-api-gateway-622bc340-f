-- 001_init.sql : skema awal ShopeePay API Gateway

CREATE TABLE IF NOT EXISTS invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             TEXT        NOT NULL,
  amount               BIGINT      NOT NULL CHECK (amount > 0),
  unique_code          INTEGER     NOT NULL DEFAULT 0 CHECK (unique_code >= 0),
  payable_amount       BIGINT      NOT NULL CHECK (payable_amount > 0),
  currency             CHAR(3)     NOT NULL DEFAULT 'IDR',
  status               TEXT        NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','PAID','EXPIRED','FAILED')),
  provider             TEXT        NOT NULL,
  provider_invoice_id  TEXT,
  provider_txn_id      TEXT,
  qris_payload         TEXT,
  qris_kind            TEXT,
  expires_at           TIMESTAMPTZ NOT NULL,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_order_id_key        UNIQUE (order_id),
  CONSTRAINT invoices_provider_txn_id_key UNIQUE (provider_txn_id)
);

-- Dua invoice PENDING tidak boleh punya nominal bayar yang sama (cegah klaim ganda).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_pending_payable_amount_uidx
  ON invoices (payable_amount) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS invoices_status_created_idx ON invoices (status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_created_idx        ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_pending_expires_idx ON invoices (expires_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS payment_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,
  from_status      TEXT,
  to_status        TEXT,
  amount           BIGINT,
  currency         CHAR(3),
  provider_txn_id  TEXT,
  source           TEXT        NOT NULL,
  event_key        TEXT,
  details          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_event_key_key UNIQUE (event_key)
);
CREATE INDEX IF NOT EXISTS payment_events_invoice_idx ON payment_events (invoice_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT        NOT NULL,
  provider         TEXT        NOT NULL,
  signature_valid  BOOLEAN     NOT NULL DEFAULT FALSE,
  simulated        BOOLEAN     NOT NULL DEFAULT FALSE,
  payload          JSONB,
  invoice_id       UUID REFERENCES invoices(id) ON DELETE SET NULL,
  result           TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  CONSTRAINT webhook_events_event_id_key UNIQUE (event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at DESC);
