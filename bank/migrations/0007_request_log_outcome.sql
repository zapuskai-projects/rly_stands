ALTER TABLE request_log ADD COLUMN error_code text;
ALTER TABLE request_log ADD COLUMN replayed boolean NOT NULL DEFAULT false;
