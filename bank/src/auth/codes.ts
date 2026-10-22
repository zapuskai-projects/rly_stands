import { createHash, randomBytes, randomInt } from 'node:crypto';

export const LOGIN_CODE_TTL_SEC = 300;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const SESSION_TTL_SEC = 12 * 60 * 60;
const TOKEN_PREFIX = 'zb_';

export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateAccessToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}
