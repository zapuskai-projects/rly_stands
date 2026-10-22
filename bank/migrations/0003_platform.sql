CREATE TABLE login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients (id),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX login_challenges_client_idx ON login_challenges (client_id, created_at DESC);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid REFERENCES clients (id),
  phone text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS', 'PUSH')),
  kind text NOT NULL,
  text text NOT NULL,
  operation_id uuid REFERENCES operations (id),
  created_at timestamptz NOT NULL
);

CREATE INDEX notifications_phone_idx ON notifications (phone, id DESC);
CREATE INDEX notifications_client_idx ON notifications (client_id, id DESC);

CREATE TABLE request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  query text,
  status integer NOT NULL,
  idempotency_key text,
  attempt_label text,
  client_id uuid,
  operation_id uuid,
  duration_ms integer NOT NULL,
  requested_at timestamptz NOT NULL
);

CREATE INDEX request_log_label_idx ON request_log (attempt_label, id);
CREATE INDEX request_log_requested_idx ON request_log (requested_at);

CREATE TABLE scenario (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  label text,
  clock_offset_ms bigint NOT NULL DEFAULT 0,
  sbp_mode text NOT NULL DEFAULT 'NORMAL' CHECK (sbp_mode IN ('NORMAL', 'REJECT', 'TIMEOUT', 'DOWN')),
  defects text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO scenario (id) VALUES (1);

CREATE TABLE defect_marks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  defect_code text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (operation_id, defect_code)
);
