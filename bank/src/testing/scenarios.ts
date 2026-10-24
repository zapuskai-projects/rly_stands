import { listDefectMarks, saveActiveDefects, type DefectMarkRecord } from '../defects/defects.repository';
import { pick, type ApiResponse, type Harness } from './harness';

export const PHONES = {
  ANNA: '+79001110001',
  PETR: '+79001110002',
  GALINA: '+79001110003',
  IP: '+79001110004',
  LI: '+79001110005',
  SERGEY: '+79001110006',
} as const;

export const SEED_CORRESPONDENT_BALANCE = 1_280_000n;
export const NEW_OPERATIONS = "SELECT 1 FROM operations WHERE request_id <> 'seed-history'";
export const NOON_MOSCOW = new Date('2026-10-20T09:00:00Z');
export const NIGHT_MOSCOW = new Date('2026-10-20T20:40:00Z');

export async function useRelease(h: Harness, release: '1.0' | '1.1' | '1.2'): Promise<void> {
  await h.pool.query('UPDATE scenario SET release = $1 WHERE id = 1', [release]);
}

export function moscow(value: string): Date {
  return new Date(`${value}+03:00`);
}

export interface AccountView {
  id: string;
  number: string;
  balance: number;
  held: number;
  available: number;
}

export async function accountOf(h: Harness, token: string, index = 0): Promise<AccountView> {
  const response = await h.api(token, 'GET', '/api/v1/accounts');
  return (pick(response.body, 'items') as AccountView[])[index] as AccountView;
}

export function phoneTransfer(fromAccount: string, recipientPhone: string, amount: number, extra: Record<string, unknown> = {}) {
  return { type: 'PHONE_TRANSFER', fromAccount, recipientPhone, amount, ...extra };
}

export function sendTransfer(h: Harness, token: string, key: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return h.api(token, 'POST', '/api/v1/transfers', body, { 'Idempotency-Key': key, ...headers });
}

export async function operationOf(h: Harness, token: string, created: ApiResponse): Promise<ApiResponse> {
  return h.api(token, 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`);
}

export async function settledTransfer(h: Harness, token: string, key: string, body: unknown): Promise<ApiResponse> {
  const created = await sendTransfer(h, token, key, body);
  await h.drain();
  return operationOf(h, token, created);
}

export async function statuses(h: Harness, token: string, created: ApiResponse): Promise<string[]> {
  const operation = await operationOf(h, token, created);
  return (pick(operation.body, 'statusHistory') as { status: string }[]).map((item) => item.status);
}

export function setDefects(h: Harness, codes: readonly string[]): Promise<void> {
  return saveActiveDefects(h.pool, codes);
}

export function marksOf(h: Harness, created: ApiResponse): Promise<DefectMarkRecord[]> {
  return listDefectMarks(h.pool, String(pick(created.body, 'id')));
}

export async function markCount(h: Harness): Promise<number> {
  const result = await h.pool.query<{ total: bigint }>('SELECT COUNT(*) AS total FROM defect_marks');
  return Number((result.rows[0] as { total: bigint }).total);
}
