ALTER TABLE autopayments ADD COLUMN cycle_on date;
ALTER TABLE autopayments ADD COLUMN series smallint NOT NULL DEFAULT 1;
UPDATE autopayments SET cycle_on = next_run_on;

ALTER TABLE autopayment_runs ADD COLUMN cycle_date date;
ALTER TABLE autopayment_runs ADD COLUMN series smallint NOT NULL DEFAULT 1;
UPDATE autopayment_runs SET cycle_date = run_date;
ALTER TABLE autopayment_runs ALTER COLUMN cycle_date SET NOT NULL;
ALTER TABLE autopayment_runs DROP CONSTRAINT autopayment_runs_autopayment_id_run_date_attempt_key;
ALTER TABLE autopayment_runs ADD CONSTRAINT autopayment_runs_cycle_attempt_key UNIQUE (autopayment_id, cycle_date, series, attempt);
