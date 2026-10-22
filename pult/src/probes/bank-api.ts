import { ProbeError } from './errors';
import { asRecord, failure, http } from './http';
import type { ProbeContext } from './types';
import { readBankSecret } from '../store/stores';

export const BANK_MODULE = 'ЗапускБанк';

const DEFAULT_BASE = 'http://kit-bank-core:18400/_kit';
const CALL_TIMEOUT_MS = 30_000;

export function kitBase(): string {
  return process.env.KIT_BANK_URL ?? DEFAULT_BASE;
}

export function publicBase(): string {
  return kitBase().replace(/\/_kit\/?$/, '');
}

function secretOf(ctx: ProbeContext): string {
  const secret = ctx.dataDir ? readBankSecret(ctx.dataDir) : null;
  if (!secret) throw new ProbeError('Секрет банка не найден: запустите банк командой ./stand up bank');
  return secret;
}

export function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter((pair): pair is [string, string] => Boolean(pair[1]));
  return pairs.length ? `?${new URLSearchParams(pairs)}` : '';
}

export function call(ctx: ProbeContext, method: 'GET' | 'POST', path: string, body?: unknown) {
  return http(BANK_MODULE, `${kitBase()}${path}`, {
    method,
    json: body,
    headers: { 'X-Kit-Secret': secretOf(ctx) },
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

export async function assertSecretAccepted(ctx: ProbeContext): Promise<void> {
  const result = await call(ctx, 'GET', '/facts/ledger');
  if (result.status === 404) {
    throw new ProbeError('Банк не принял секрет пульта: перезапустите банк командой ./stand reset kit-bank и повторите');
  }
}

export async function fetchOperation(ctx: ProbeContext, id: string): Promise<Record<string, unknown> | null> {
  if (!id.trim()) return null;
  const result = await call(ctx, 'GET', `/facts/operations/${encodeURIComponent(id)}`);
  if (result.status === 404) {
    await assertSecretAccepted(ctx);
    return null;
  }
  if (!result.ok) throw failure(BANK_MODULE, 'чтение операции', result);
  return asRecord(result.json);
}

export async function accepted(ctx: ProbeContext, path: string, body: unknown, action: string) {
  const result = await call(ctx, 'POST', path, body);
  if (!result.ok) throw failure(BANK_MODULE, action, result);
  return asRecord(result.json);
}

export const NOON = 'noon';

export function resolveBankTime(value: string | null | undefined, now: Date = new Date()): string | null {
  if (value === undefined) return null;
  if (value !== NOON) return value;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
  return `${day}T12:00`;
}
