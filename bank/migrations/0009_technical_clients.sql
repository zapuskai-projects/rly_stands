ALTER TABLE clients ADD COLUMN technical boolean NOT NULL DEFAULT false;

CREATE INDEX clients_technical_idx ON clients (technical) WHERE technical;
