CREATE TABLE webhook_delivery_marks (
  event_id uuid NOT NULL REFERENCES webhook_deliveries (event_id) ON DELETE CASCADE,
  defect_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, defect_code)
);

DO $$
BEGIN
  EXECUTE format('ALTER TABLE webhook_delivery_marks SET SCHEMA %I', current_setting('bank.internal_schema'));
END $$;
