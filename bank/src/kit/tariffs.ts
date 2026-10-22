import { rubles, toApiAmount } from '../accounts/money';
import type { Db } from '../db/pool';
import { unprocessable } from '../shared/errors';
import type { Tariff } from '../tariffs/tariff';
import { listTariffs, updateTariffValues } from '../tariffs/tariffs.repository';
import type { TariffPatchInput } from './schemas';

export interface TariffFact {
  code: string;
  name: string;
  dailyLimitKop: number;
  freeMonthlyKop: number;
  rateBps: number;
  minKop: number;
  maxKop: number;
}

export const TARIFF_DEFAULTS: readonly Tariff[] = [
  { code: 'START', name: 'Старт', dailyPhoneLimit: rubles(150_000), freeMonthlyVolume: rubles(100_000), commissionRateBps: 100, commissionMin: rubles(30), commissionMax: rubles(1_500) },
  { code: 'PENSION', name: 'Пенсионный', dailyPhoneLimit: rubles(50_000), freeMonthlyVolume: rubles(100_000), commissionRateBps: 100, commissionMin: rubles(30), commissionMax: rubles(1_500) },
];

export function tariffFact(tariff: Tariff): TariffFact {
  return {
    code: tariff.code,
    name: tariff.name,
    dailyLimitKop: toApiAmount(tariff.dailyPhoneLimit),
    freeMonthlyKop: toApiAmount(tariff.freeMonthlyVolume),
    rateBps: tariff.commissionRateBps,
    minKop: toApiAmount(tariff.commissionMin),
    maxKop: toApiAmount(tariff.commissionMax),
  };
}

export async function findTariffs(db: Db): Promise<Map<string, Tariff>> {
  return new Map((await listTariffs(db)).map((tariff) => [tariff.code, tariff]));
}

export function mergeTariff(current: Tariff, patch: TariffPatchInput): Tariff {
  const merged: Tariff = {
    ...current,
    dailyPhoneLimit: patch.dailyLimitKop === undefined ? current.dailyPhoneLimit : BigInt(patch.dailyLimitKop),
    freeMonthlyVolume: patch.freeMonthlyKop === undefined ? current.freeMonthlyVolume : BigInt(patch.freeMonthlyKop),
    commissionRateBps: patch.rateBps ?? current.commissionRateBps,
    commissionMin: patch.minKop === undefined ? current.commissionMin : BigInt(patch.minKop),
    commissionMax: patch.maxKop === undefined ? current.commissionMax : BigInt(patch.maxKop),
  };
  if (merged.commissionMin > merged.commissionMax) {
    throw unprocessable('INVALID_TARIFF', 'Минимальная комиссия не может быть больше максимальной');
  }
  return merged;
}

export async function applyTariffPatch(db: Db, patch: TariffPatchInput): Promise<Tariff> {
  const current = (await findTariffs(db)).get(patch.code);
  if (!current) throw unprocessable('UNKNOWN_TARIFF', `Тариф ${patch.code} не найден`);
  const merged = mergeTariff(current, patch);
  const updated = await updateTariffValues(db, patch.code, {
    dailyPhoneLimit: merged.dailyPhoneLimit,
    freeMonthlyVolume: merged.freeMonthlyVolume,
    commissionRateBps: merged.commissionRateBps,
    commissionMin: merged.commissionMin,
    commissionMax: merged.commissionMax,
  });
  return updated as Tariff;
}

export async function restoreDefaultTariffs(db: Db): Promise<void> {
  for (const tariff of TARIFF_DEFAULTS) {
    await updateTariffValues(db, tariff.code, {
      dailyPhoneLimit: tariff.dailyPhoneLimit,
      freeMonthlyVolume: tariff.freeMonthlyVolume,
      commissionRateBps: tariff.commissionRateBps,
      commissionMin: tariff.commissionMin,
      commissionMax: tariff.commissionMax,
    });
  }
}
