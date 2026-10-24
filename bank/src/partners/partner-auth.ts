import type { Pool } from 'pg';
import { unauthorized } from '../shared/errors';
import { findPartnerByKey, type Partner } from './partners.repository';

export async function authenticatePartner(pool: Pool, key: string | undefined): Promise<Partner> {
  if (!key) throw unauthorized('PARTNER_KEY_REQUIRED', 'Нужен ключ магазина в заголовке X-Partner-Key');
  const partner = await findPartnerByKey(pool, key.trim());
  if (!partner) throw unauthorized('PARTNER_KEY_INVALID', 'Ключ магазина неверен');
  return partner;
}
