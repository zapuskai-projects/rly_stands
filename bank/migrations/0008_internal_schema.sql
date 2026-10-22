DO $$
DECLARE
  target text := current_setting('bank.internal_schema');
  moved text[] := ARRAY[
    'idempotency_keys', 'login_challenges', 'sessions', 'scenario', 'defect_marks', 'outbox_events',
    'antifraud_settings', 'antifraud_decisions', 'manual_reviews', 'sbp_transfers',
    'operators', 'operator_sessions', 'sbp_directory'
  ];
  item text;
BEGIN
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', target);
  FOREACH item IN ARRAY moved LOOP
    EXECUTE format('ALTER TABLE %I SET SCHEMA %I', item, target);
  END LOOP;
END $$;
