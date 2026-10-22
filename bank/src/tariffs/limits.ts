import type { Kopecks } from '../accounts/money';

export interface DailyLimitInput {
  limit: Kopecks;
  usedToday: Kopecks;
  amount: Kopecks;
  strict?: boolean;
}

export interface DailyLimitCheck {
  allowed: boolean;
  remaining: Kopecks;
}

export function checkDailyLimit({ limit, usedToday, amount, strict = false }: DailyLimitInput): DailyLimitCheck {
  const total = usedToday + amount;
  return {
    allowed: strict ? total < limit : total <= limit,
    remaining: limit > usedToday ? limit - usedToday : 0n,
  };
}

export function effectiveDailyLimit(tariffLimit: Kopecks, clientOverride: Kopecks | null): Kopecks {
  return clientOverride ?? tariffLimit;
}
