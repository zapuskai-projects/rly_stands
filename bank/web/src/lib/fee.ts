import type { Tariff } from './types';

export interface FeeInput {
  amount: number;
  route: 'INTERNAL' | 'SBP';
  freeRemaining: number;
  tariff: Pick<Tariff, 'commissionRateBps' | 'commissionMin' | 'commissionMax'>;
}

export function previewFee({ amount, route, freeRemaining, tariff }: FeeInput): number {
  if (route !== 'SBP') return 0;
  const chargeable = Math.max(0, amount - Math.max(0, freeRemaining));
  if (chargeable === 0) return 0;
  const raw = Math.floor((chargeable * tariff.commissionRateBps * 2 + 10_000) / 20_000);
  return Math.min(tariff.commissionMax, Math.max(tariff.commissionMin, raw));
}
