export const DEFECT_CODES = [
  'limit-boundary',
  'idempotency-double-debit',
  'commission-rounding',
  'daily-limit-utc',
  'sbp-timeout-stuck',
  'notify-before-complete',
  'kafka-amount-mismatch',
  'events.duplicate-delivery',
] as const;

export type DefectCode = (typeof DEFECT_CODES)[number];
export type DefectSet = ReadonlySet<DefectCode>;

export const NO_DEFECTS: DefectSet = new Set<DefectCode>();

export interface DefectMark {
  code: DefectCode;
  details: Record<string, unknown>;
}

export function isDefectCode(value: string): value is DefectCode {
  return (DEFECT_CODES as readonly string[]).includes(value);
}

export function parseDefectCodes(values: readonly string[]): DefectSet {
  return new Set(values.filter(isDefectCode));
}
