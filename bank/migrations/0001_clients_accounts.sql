CREATE TABLE tariffs (
  code text PRIMARY KEY,
  name text NOT NULL,
  daily_phone_limit_kop bigint NOT NULL CHECK (daily_phone_limit_kop >= 0),
  free_monthly_volume_kop bigint NOT NULL CHECK (free_monthly_volume_kop >= 0),
  commission_rate_bps integer NOT NULL CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  commission_min_kop bigint NOT NULL CHECK (commission_min_kop >= 0),
  commission_max_kop bigint NOT NULL CHECK (commission_max_kop >= commission_min_kop),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tariffs (code, name, daily_phone_limit_kop, free_monthly_volume_kop, commission_rate_bps, commission_min_kop, commission_max_kop) VALUES
  ('START', 'Старт', 15000000, 10000000, 100, 3000, 150000),
  ('PENSION', 'Пенсионный', 5000000, 10000000, 100, 3000, 150000);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+79[0-9]{9}$'),
  kind text NOT NULL CHECK (kind IN ('INDIVIDUAL', 'ENTREPRENEUR')),
  resident boolean NOT NULL DEFAULT true,
  inn text CHECK (inn IS NULL OR inn ~ '^[0-9]{10}$|^[0-9]{12}$'),
  tariff_code text NOT NULL REFERENCES tariffs (code),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  created_at timestamptz NOT NULL
);

CREATE TABLE client_limits (
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  limit_kind text NOT NULL CHECK (limit_kind IN ('DAILY_PHONE_TRANSFER')),
  amount_kop bigint NOT NULL CHECK (amount_kop >= 0),
  PRIMARY KEY (client_id, limit_kind)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (number ~ '^[0-9]{20}$'),
  client_id uuid REFERENCES clients (id),
  kind text NOT NULL CHECK (kind IN ('CURRENT', 'SAVINGS', 'SETTLEMENT', 'CORRESPONDENT', 'INCOME', 'OPENING')),
  title text NOT NULL,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARRESTED', 'CLOSED')),
  is_primary boolean NOT NULL DEFAULT false,
  balance_kop bigint NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL,
  CHECK ((client_id IS NULL) = (kind IN ('CORRESPONDENT', 'INCOME', 'OPENING'))),
  CHECK (kind IN ('CORRESPONDENT', 'INCOME', 'OPENING') OR balance_kop >= 0)
);

CREATE INDEX accounts_client_idx ON accounts (client_id);
CREATE UNIQUE INDEX accounts_one_primary_per_client ON accounts (client_id) WHERE is_primary;

CREATE TABLE cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (number ~ '^[0-9]{16}$'),
  client_id uuid NOT NULL REFERENCES clients (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  product text NOT NULL,
  holder_name text NOT NULL,
  expiry_month smallint NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year smallint NOT NULL CHECK (expiry_year BETWEEN 2000 AND 2099),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED'))
);

CREATE INDEX cards_account_idx ON cards (account_id);

CREATE TABLE partner_banks (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO partner_banks (code, name) VALUES
  ('NORTHWIND', 'Банк «Северный ветер»'),
  ('LAZURIT', 'Банк «Лазурит»'),
  ('KEDR', 'Банк «Кедр»');
