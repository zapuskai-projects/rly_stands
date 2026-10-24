import { createHash, timingSafeEqual } from 'node:crypto';

export const PARTNER_KEY_HEADER = 'x-partner-key';

export const LAVKA_PARTNER_KEY = 'zbk_test_lavka_7f3a91c4e2d85b60a1c9';

export function hashPartnerKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
