export type Kopecks = bigint;

const KOPECKS_IN_RUBLE = 100n;
const NO_BREAK_SPACE = ' ';

export function rubles(whole: number): Kopecks {
  if (!Number.isSafeInteger(whole)) throw new RangeError('Сумма в рублях должна быть целым числом');
  return BigInt(whole) * KOPECKS_IN_RUBLE;
}

export function formatRubles(amount: Kopecks): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = (absolute / KOPECKS_IN_RUBLE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NO_BREAK_SPACE);
  const fraction = (absolute % KOPECKS_IN_RUBLE).toString().padStart(2, '0');
  return `${negative ? '−' : ''}${whole},${fraction}${NO_BREAK_SPACE}₽`;
}

export function mulDivRoundHalfUp(value: Kopecks, numerator: bigint, denominator: bigint): Kopecks {
  if (value < 0n || numerator < 0n || denominator <= 0n) throw new RangeError('Допустимы только неотрицательные значения');
  return (value * numerator * 2n + denominator) / (denominator * 2n);
}

export function clampKopecks(value: Kopecks, min: Kopecks, max: Kopecks): Kopecks {
  if (min > max) throw new RangeError('Нижняя граница больше верхней');
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function toApiAmount(amount: Kopecks): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) throw new RangeError('Сумма не помещается в целое число JSON');
  return value;
}

export function fromApiAmount(value: number): Kopecks {
  if (!Number.isSafeInteger(value)) throw new RangeError('Сумма должна быть целым числом копеек');
  return BigInt(value);
}
