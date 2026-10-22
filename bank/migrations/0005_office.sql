CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL UNIQUE,
  full_name text NOT NULL,
  short_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('OPERATOR', 'SENIOR')),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at timestamptz NOT NULL
);

CREATE TABLE operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE sbp_directory (
  phone text NOT NULL CHECK (phone ~ '^\+79[0-9]{9}$'),
  bank_code text NOT NULL REFERENCES partner_banks (code),
  display_name text NOT NULL,
  PRIMARY KEY (phone, bank_code)
);

INSERT INTO sbp_directory (phone, bank_code, display_name) VALUES
  ('+79000000017', 'NORTHWIND', 'Мария П.'),
  ('+79000000021', 'NORTHWIND', 'Иван К.'),
  ('+79000000022', 'LAZURIT', 'Ольга С.'),
  ('+79000000031', 'KEDR', 'Дмитрий В.'),
  ('+79000000032', 'LAZURIT', 'Елена Н.'),
  ('+79000000033', 'KEDR', 'Сергей Т.');
