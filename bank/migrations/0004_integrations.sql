CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination text NOT NULL CHECK (destination IN ('KAFKA', 'RABBIT')),
  topic text NOT NULL,
  message_key text,
  headers jsonb NOT NULL DEFAULT '{}',
  payload json NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX outbox_events_pending_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE antifraud_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  review_threshold integer NOT NULL DEFAULT 70 CHECK (review_threshold BETWEEN 1 AND 100),
  reject_threshold integer NOT NULL DEFAULT 90 CHECK (reject_threshold BETWEEN 1 AND 100),
  CHECK (review_threshold <= reject_threshold)
);

INSERT INTO antifraud_settings (id) VALUES (1);

CREATE TABLE antifraud_decisions (
  operation_id uuid PRIMARY KEY REFERENCES operations (id),
  score integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REVIEW', 'REJECT')),
  rules jsonb NOT NULL,
  review_threshold integer NOT NULL,
  reject_threshold integer NOT NULL,
  decided_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL
);

CREATE TABLE manual_reviews (
  operation_id uuid PRIMARY KEY REFERENCES operations (id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  comment text
);

CREATE INDEX manual_reviews_pending_idx ON manual_reviews (deadline_at) WHERE state = 'PENDING';
CREATE INDEX manual_reviews_state_idx ON manual_reviews (state, created_at DESC);

CREATE TABLE sbp_transfers (
  operation_id uuid PRIMARY KEY REFERENCES operations (id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENT', 'ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'TIMED_OUT')),
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  answered_at timestamptz,
  reason text
);

CREATE INDEX sbp_transfers_open_idx ON sbp_transfers (created_at) WHERE state IN ('PENDING', 'SENT');

ALTER TABLE notifications ADD COLUMN message_id uuid UNIQUE;
