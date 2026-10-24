CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  client_id uuid NOT NULL REFERENCES clients (id),
  settlement_account_id uuid NOT NULL REFERENCES accounts (id),
  api_key_hash text NOT NULL UNIQUE,
  commission_bps integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  webhook_url text,
  webhook_secret text,
  created_at timestamptz NOT NULL
);

CREATE TABLE qr_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners (id),
  order_id text NOT NULL,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'CANCELLED')),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 60 AND 3600),
  commission_kop bigint NOT NULL DEFAULT 0 CHECK (commission_kop >= 0),
  refunded_kop bigint NOT NULL DEFAULT 0 CHECK (refunded_kop >= 0),
  paid_operation_id uuid REFERENCES operations (id),
  pending_operation_id uuid REFERENCES operations (id),
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (partner_id, order_id)
);

CREATE INDEX qr_codes_open_idx ON qr_codes (expires_at) WHERE status = 'CREATED';

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type IN ('OWN_TRANSFER', 'PHONE_TRANSFER', 'QR_PAYMENT', 'QR_REFUND'));
ALTER TABLE operations ADD COLUMN qr_id uuid REFERENCES qr_codes (id);

CREATE INDEX operations_qr_idx ON operations (qr_id) WHERE qr_id IS NOT NULL;

DO $$
BEGIN
  EXECUTE format('ALTER TABLE partners SET SCHEMA %I', current_setting('bank.internal_schema'));
END $$;
