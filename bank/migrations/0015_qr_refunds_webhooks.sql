ALTER TABLE qr_codes ADD COLUMN attempt_label text;

CREATE TABLE qr_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_id uuid NOT NULL REFERENCES qr_codes (id),
  partner_id uuid NOT NULL REFERENCES partners (id),
  operation_id uuid NOT NULL REFERENCES operations (id),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (partner_id, idempotency_key)
);

CREATE INDEX qr_refunds_qr_idx ON qr_refunds (qr_id, created_at);

CREATE TABLE webhook_deliveries (
  event_id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners (id),
  event text NOT NULL CHECK (event IN ('qr.paid', 'qr.refunded')),
  qr_id uuid NOT NULL REFERENCES qr_codes (id),
  operation_id uuid NOT NULL REFERENCES operations (id),
  url text NOT NULL,
  secret text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempts_made smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX webhook_deliveries_qr_idx ON webhook_deliveries (qr_id, created_at);

CREATE TABLE webhook_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES webhook_deliveries (event_id) ON DELETE CASCADE,
  attempt smallint NOT NULL,
  at timestamptz NOT NULL,
  status_code integer,
  error text,
  duration_ms integer NOT NULL,
  UNIQUE (event_id, attempt)
);

DO $$
DECLARE
  target text := current_setting('bank.internal_schema');
BEGIN
  EXECUTE format('ALTER TABLE webhook_deliveries SET SCHEMA %I', target);
  EXECUTE format('ALTER TABLE webhook_attempts SET SCHEMA %I', target);
END $$;
