CREATE TABLE autopayment_run_marks (
  run_id uuid NOT NULL REFERENCES autopayment_runs (id),
  defect_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, defect_code)
);

DO $$
BEGIN
  EXECUTE format('ALTER TABLE autopayment_run_marks SET SCHEMA %I', current_setting('bank.internal_schema'));
END $$;
