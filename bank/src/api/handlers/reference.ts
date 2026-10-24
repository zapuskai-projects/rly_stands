import type { Pool } from 'pg';
import { listNotificationsByPhone } from '../../notifications/notifications.repository';
import { toMoscowIso } from '../../clock/moscow';
import { BANK } from '../../shared/bank-identity';
import type { ReleaseSource } from '../../release/release-source';
import type { Readiness } from '../../shared/readiness';
import type { Handler } from '../router';

const DEFAULT_SMS_LIMIT = 10;

export function referenceHandlers(pool: Pool, releases: ReleaseSource, readiness?: Readiness): Record<string, Handler> {
  return {
    listBanks: async () => {
      const partners = await pool.query<{ code: string; name: string }>(
        'SELECT code, name FROM partner_banks WHERE active ORDER BY name',
      );
      return { status: 200, body: { items: [{ code: BANK.code, name: BANK.name }, ...partners.rows] } };
    },
    listSandboxSms: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_SMS_LIMIT;
      const rows = await listNotificationsByPhone(pool, String(ctx.query.phone), limit);
      const items = rows.map((row) => ({
        id: row.id,
        phone: row.phone,
        channel: row.channel,
        kind: row.kind,
        text: row.text,
        createdAt: toMoscowIso(row.createdAt),
      }));
      return { status: 200, body: { items } };
    },
    getHealth: async () => {
      try {
        await pool.query('SELECT 1');
      } catch {
        return { status: 503, body: { status: 'DOWN', database: 'DOWN' } };
      }
      if (readiness && !readiness.isReady()) return { status: 503, body: { status: 'DOWN', database: 'UP' } };
      return { status: 200, body: { status: 'UP', database: 'UP', release: await releases.current() } };
    },
  };
}
