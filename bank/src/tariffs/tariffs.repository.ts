import type { Db } from '../db/pool';
import type { Tariff } from './tariff';

interface TariffRow {
  code: string;
  name: string;
  daily_phone_limit_kop: bigint;
  free_monthly_volume_kop: bigint;
  commission_rate_bps: number;
  commission_min_kop: bigint;
  commission_max_kop: bigint;
}

function mapTariff(row: TariffRow): Tariff {
  return {
    code: row.code,
    name: row.name,
    dailyPhoneLimit: row.daily_phone_limit_kop,
    freeMonthlyVolume: row.free_monthly_volume_kop,
    commissionRateBps: row.commission_rate_bps,
    commissionMin: row.commission_min_kop,
    commissionMax: row.commission_max_kop,
  };
}

export async function getTariff(db: Db, code: string): Promise<Tariff> {
  const result = await db.query<TariffRow>(
    `SELECT code, name, daily_phone_limit_kop, free_monthly_volume_kop, commission_rate_bps, commission_min_kop, commission_max_kop
     FROM tariffs WHERE code = $1`,
    [code],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Тариф ${code} не найден`);
  return mapTariff(row);
}

export async function listTariffs(db: Db): Promise<Tariff[]> {
  const result = await db.query<TariffRow>(
    `SELECT code, name, daily_phone_limit_kop, free_monthly_volume_kop, commission_rate_bps, commission_min_kop, commission_max_kop
     FROM tariffs ORDER BY code DESC`,
  );
  return result.rows.map(mapTariff);
}

export interface TariffChange {
  dailyPhoneLimit: bigint;
  freeMonthlyVolume: bigint;
  commissionRateBps: number;
  commissionMin: bigint;
  commissionMax: bigint;
}

export async function updateTariffValues(db: Db, code: string, change: TariffChange): Promise<Tariff | null> {
  const result = await db.query<TariffRow>(
    `UPDATE tariffs SET daily_phone_limit_kop = $2, free_monthly_volume_kop = $3, commission_rate_bps = $4,
       commission_min_kop = $5, commission_max_kop = $6, updated_at = now()
     WHERE code = $1
     RETURNING code, name, daily_phone_limit_kop, free_monthly_volume_kop, commission_rate_bps, commission_min_kop, commission_max_kop`,
    [code, change.dailyPhoneLimit, change.freeMonthlyVolume, change.commissionRateBps, change.commissionMin, change.commissionMax],
  );
  const row = result.rows[0];
  return row ? mapTariff(row) : null;
}
