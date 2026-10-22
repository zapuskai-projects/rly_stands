import { clampKopecks, mulDivRoundHalfUp, type Kopecks } from '../accounts/money';
import type { Tariff } from './tariff';

const BASIS_POINTS_IN_WHOLE = 10_000n;
const KOPECKS_IN_RUBLE = 100n;

export interface CommissionInput {
  amount: Kopecks;
  monthlyVolumeBefore: Kopecks;
  tariff: Pick<Tariff, 'freeMonthlyVolume' | 'commissionRateBps' | 'commissionMin' | 'commissionMax'>;
}

export function remainingFreeVolume(freeMonthlyVolume: Kopecks, monthlyVolumeBefore: Kopecks): Kopecks {
  return freeMonthlyVolume > monthlyVolumeBefore ? freeMonthlyVolume - monthlyVolumeBefore : 0n;
}

function chargeableAmount({ amount, monthlyVolumeBefore, tariff }: CommissionInput): Kopecks {
  const freeLeft = remainingFreeVolume(tariff.freeMonthlyVolume, monthlyVolumeBefore);
  return amount > freeLeft ? amount - freeLeft : 0n;
}

function commissionWith(input: CommissionInput, round: (raw: Kopecks) => Kopecks): Kopecks {
  const chargeable = chargeableAmount(input);
  if (chargeable === 0n) return 0n;
  const raw = mulDivRoundHalfUp(chargeable, BigInt(input.tariff.commissionRateBps), BASIS_POINTS_IN_WHOLE);
  return clampKopecks(round(raw), input.tariff.commissionMin, input.tariff.commissionMax);
}

export function calculateCommission(input: CommissionInput): Kopecks {
  return commissionWith(input, (raw) => raw);
}

export function calculateCommissionDroppingKopecks(input: CommissionInput): Kopecks {
  return commissionWith(input, (raw) => (raw / KOPECKS_IN_RUBLE) * KOPECKS_IN_RUBLE);
}
