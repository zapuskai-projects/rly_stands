CREATE TABLE transfer_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('PHONE', 'OWN', 'SBP')),
  from_account_id uuid NOT NULL REFERENCES accounts (id),
  to_account_id uuid REFERENCES accounts (id),
  recipient_phone text,
  recipient_bank_code text,
  amount_kop bigint CHECK (amount_kop > 0),
  comment text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE UNIQUE INDEX transfer_templates_client_name_idx ON transfer_templates (client_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX transfer_templates_client_idx ON transfer_templates (client_id, created_at) WHERE deleted_at IS NULL;

ALTER TABLE operations ADD COLUMN template_id uuid REFERENCES transfer_templates (id);

CREATE TABLE autopayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients (id),
  template_id uuid NOT NULL REFERENCES transfer_templates (id),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  ends_on date,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'FAILED', 'FINISHED')),
  next_run_on date,
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  reminded_for date,
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX autopayments_due_idx ON autopayments (next_run_on) WHERE status = 'ACTIVE';
CREATE INDEX autopayments_client_idx ON autopayments (client_id, created_at);
CREATE INDEX autopayments_template_idx ON autopayments (template_id);

CREATE TABLE autopayment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  autopayment_id uuid NOT NULL REFERENCES autopayments (id),
  run_date date NOT NULL,
  attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  outcome text NOT NULL CHECK (outcome IN ('PENDING', 'EXECUTED', 'FAILED')),
  operation_id uuid REFERENCES operations (id),
  reason_code text,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (autopayment_id, run_date, attempt)
);

CREATE INDEX autopayment_runs_pending_idx ON autopayment_runs (started_at) WHERE outcome = 'PENDING';
