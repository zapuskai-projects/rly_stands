export const RELEASES = ['1.0', '1.1', '1.2'] as const;

export type Release = (typeof RELEASES)[number];

export const DEFAULT_RELEASE: Release = '1.0';

export function isRelease(value: unknown): value is Release {
  return (RELEASES as readonly unknown[]).includes(value);
}

export function parseRelease(value: unknown, where: string): Release {
  if (isRelease(value)) return value;
  throw new Error(`${where}: релиз ${String(value)} неизвестен, допустимы ${RELEASES.join(', ')}`);
}

export function releaseAtLeast(current: Release, required: Release): boolean {
  return RELEASES.indexOf(current) >= RELEASES.indexOf(required);
}

export const QR_OPERATION_TYPES = ['QR_PAYMENT', 'QR_REFUND'] as const;

export function hiddenOperationTypes(current: Release): readonly (typeof QR_OPERATION_TYPES)[number][] {
  return releaseAtLeast(current, '1.2') ? [] : QR_OPERATION_TYPES;
}
