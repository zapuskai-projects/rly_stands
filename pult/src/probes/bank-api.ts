import { ProbeError } from './errors';
import { asRecord, failure, http } from './http';
import type { ProbeContext } from './types';
import { readBankSecret } from '../store/stores';

export const BANK_MODULE = 'ЗапускБанк';

export const BANK_RELEASES = ['1.0', '1.1', '1.2'];

export const PARTNER_KEY = 'zbk_test_lavka_7f3a91c4e2d85b60a1c9';

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
export const NIGHT = 'night';

const BANK_TIME_PRESETS: Record<string, string> = { [NOON]: '12:00', [NIGHT]: '23:10' };
const PRESET_WITH_OFFSET = /^(noon|night)\+(\d{1,4})m$/;
const MINUTE_MS = 60_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function resolveBankTime(value: string | null | undefined, now: Date = new Date()): string | null {
  if (value === undefined || value === null) return null;
  const shifted = PRESET_WITH_OFFSET.exec(value);
  const presetKey = shifted?.[1] ?? value;
  const preset = Object.hasOwn(BANK_TIME_PRESETS, presetKey) ? BANK_TIME_PRESETS[presetKey] : undefined;
  if (!preset) return value;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
  if (!shifted) return `${day}T${preset}`;
  const [hours = 0, minutes = 0] = preset.split(':').map(Number);
  const moment = new Date(Date.parse(`${day}T00:00:00Z`) + (hours * 60 + minutes + Number(shifted[2])) * MINUTE_MS);
  return `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`;
}

export function resolvePersonaTimes(personas: unknown[], now: Date = new Date()): unknown[] {
  return personas.map((persona) => {
    const history = (persona as { history?: Array<{ at: string; amountKop: number }> }).history;
    if (!history) return persona;
    return { ...(persona as object), history: history.map((item) => ({ ...item, at: resolveBankTime(item.at, now) })) };
  });
}

export function hasFunding(personas: unknown[] | undefined): boolean {
  return (personas ?? []).some((persona) => {
    const row = persona as { topUpKop?: unknown; history?: unknown };
    return row.topUpKop !== undefined || row.history !== undefined;
  });
}
