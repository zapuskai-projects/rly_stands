ALTER TABLE scenario ADD COLUMN release text NOT NULL DEFAULT '1.0' CHECK (release IN ('1.0', '1.1', '1.2'));
