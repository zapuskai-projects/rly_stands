import type { Db } from '../db/pool';
import { hashPartnerKey, LAVKA_PARTNER_KEY } from './partner-key';

export interface Partner {
  id: string;
  code: string;
  name: string;
  clientId: string;
  settlementAccountId: string;
  settlementAccountNumber: string;
  commissionBps: number;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

interface PartnerRow {
  id: string;
  code: string;
  name: string;
  client_id: string;
  settlement_account_id: string;
  settlement_account_number: string;
  commission_bps: number;
  webhook_url: string | null;
  webhook_secret: string | null;
}

const SELECT_PARTNER = `
  SELECT p.id, p.code, p.name, p.client_id, p.settlement_account_id, a.number AS settlement_account_number,
         p.commission_bps, p.webhook_url, p.webhook_secret
  FROM partners p JOIN accounts a ON a.id = p.settlement_account_id`;

function mapPartner(row: PartnerRow): Partner {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    clientId: row.client_id,
    settlementAccountId: row.settlement_account_id,
    settlementAccountNumber: row.settlement_account_number,
    commissionBps: row.commission_bps,
    webhookUrl: row.webhook_url,
    webhookSecret: row.webhook_secret,
  };
}

export async function findPartnerByKey(db: Db, key: string): Promise<Partner | null> {
  const result = await db.query<PartnerRow>(`${SELECT_PARTNER} WHERE p.api_key_hash = $1`, [hashPartnerKey(key)]);
  const row = result.rows[0];
  return row ? mapPartner(row) : null;
}

export async function findPartnerById(db: Db, partnerId: string): Promise<Partner | null> {
  const result = await db.query<PartnerRow>(`${SELECT_PARTNER} WHERE p.id = $1`, [partnerId]);
  const row = result.rows[0];
  return row ? mapPartner(row) : null;
}

export async function setPartnerWebhook(db: Db, partnerId: string, url: string, secret: string): Promise<void> {
  await db.query('UPDATE partners SET webhook_url = $2, webhook_secret = $3 WHERE id = $1', [partnerId, url, secret]);
}

export const LAVKA_PARTNER = {
  code: 'lavka-garipova',
  name: 'Лавка Гарипова',
  ownerClientNumber: '10000004',
  commissionBps: 70,
} as const;

export async function ensureLavkaPartner(db: Db, at: Date): Promise<boolean> {
  const owner = await db.query<{ client_id: string; account_id: string }>(
    `SELECT c.id AS client_id, a.id AS account_id FROM clients c
     JOIN accounts a ON a.client_id = c.id AND a.kind = 'SETTLEMENT' AND a.status <> 'CLOSED'
     WHERE c.number = $1 ORDER BY a.is_primary DESC, a.opened_at LIMIT 1`,
    [LAVKA_PARTNER.ownerClientNumber],
  );
  const target = owner.rows[0];
  if (!target) return false;
  const inserted = await db.query(
    `INSERT INTO partners (code, name, client_id, settlement_account_id, api_key_hash, commission_bps, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (code) DO NOTHING`,
    [LAVKA_PARTNER.code, LAVKA_PARTNER.name, target.client_id, target.account_id, hashPartnerKey(LAVKA_PARTNER_KEY), LAVKA_PARTNER.commissionBps, at],
  );
  return (inserted.rowCount ?? 0) > 0;
}
