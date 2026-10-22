ALTER TABLE defect_marks ADD COLUMN details jsonb NOT NULL DEFAULT '{}';

CREATE INDEX defect_marks_code_idx ON defect_marks (defect_code, created_at);
