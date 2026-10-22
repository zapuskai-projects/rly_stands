CREATE SEQUENCE operation_number_seq START 100001;

CREATE TABLE operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT ('ZB' || lpad(nextval('operation_number_seq')::text, 10, '0')),
  client_id uuid NOT NULL REFERENCES clients (id),
  type text NOT NULL CHECK (type IN ('OWN_TRANSFER', 'PHONE_TRANSFER')),
  route text NOT NULL CHECK (route IN ('INTERNAL', 'SBP')),
  status text NOT NULL CHECK (status IN ('CREATED', 'CHECKING', 'ON_REVIEW', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED')),
  from_account_id uuid NOT NULL REFERENCES accounts (id),
  to_account_id uuid REFERENCES accounts (id),
  recipient_phone text,
  recipient_bank_code text,
  recipient_name text,
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  fee_kop bigint NOT NULL DEFAULT 0 CHECK (fee_kop >= 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  comment text,
  reject_code text,
  reject_message text,
  attempt_label text,
  request_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX operations_client_created_idx ON operations (client_id, created_at DESC);
CREATE INDEX operations_client_type_created_idx ON operations (client_id, type, created_at);
CREATE INDEX operations_status_idx ON operations (status);

CREATE TABLE operation_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  status text NOT NULL,
  reason_code text,
  comment text,
  actor text NOT NULL DEFAULT 'SYSTEM',
  changed_at timestamptz NOT NULL
);

CREATE INDEX operation_status_history_operation_idx ON operation_status_history (operation_id, id);

CREATE TABLE postings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid REFERENCES operations (id),
  debit_account_id uuid NOT NULL REFERENCES accounts (id),
  credit_account_id uuid NOT NULL REFERENCES accounts (id),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  kind text NOT NULL CHECK (kind IN ('TRANSFER', 'FEE', 'OPENING', 'REFUND')),
  description text NOT NULL,
  posted_at timestamptz NOT NULL,
  CHECK (debit_account_id <> credit_account_id)
);

CREATE INDEX postings_debit_idx ON postings (debit_account_id, posted_at);
CREATE INDEX postings_credit_idx ON postings (credit_account_id, posted_at);
CREATE INDEX postings_operation_idx ON postings (operation_id);

CREATE TABLE holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  operation_id uuid NOT NULL REFERENCES operations (id),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CAPTURED', 'RELEASED')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz
);

CREATE INDEX holds_active_idx ON holds (account_id) WHERE status = 'ACTIVE';
CREATE INDEX holds_operation_idx ON holds (operation_id);

CREATE TABLE idempotency_keys (
  client_id uuid NOT NULL REFERENCES clients (id),
  key text NOT NULL,
  request_hash text NOT NULL,
  operation_id uuid NOT NULL REFERENCES operations (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, key)
);
