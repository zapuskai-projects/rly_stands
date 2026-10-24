import { toApiAmount } from '../accounts/money';
import { findDailyLimitOverride } from '../clients/clients.repository';
import type { Db } from '../db/pool';
import { loadPhoneTransferUsage } from '../payments/usage';
import { effectiveDailyLimit } from '../tariffs/limits';
import { getTariff } from '../tariffs/tariffs.repository';
import { hadOtherOnReview, limitTrace, type TraceOperation } from './limit-trace';

export interface OperationTraceFacts {
  wasOnReview: boolean;
  createdWhileOtherOnReview: boolean;
  limitBeforeKop: number | null;
  limitAfterKop: number | null;
  limitMarginKop: number | null;
  limitBeforeRub: number | null;
  clientRemainingKop: number;
  clientRemainingRub: number;
}

interface SiblingRow {
  id: string;
  client_id: string;
  number: string;
  type: string;
  status: string;
  amount_kop: bigint;
  created_at: Date;
}

const rubles = (kop: bigint): number => Number(kop) / 100;

async function loadSiblings(db: Db, clientIds: string[]): Promise<Map<string, TraceOperation[]>> {
  const rows = await db.query<SiblingRow>(
    'SELECT id, client_id, number, type, status, amount_kop, created_at FROM operations WHERE client_id = ANY($1::uuid[])',
    [clientIds],
  );
  const history = await db.query<{ operation_id: string; status: string; changed_at: Date }>(
    'SELECT operation_id, status, changed_at FROM operation_status_history WHERE operation_id = ANY($1::uuid[]) ORDER BY id',
    [rows.rows.map((row) => row.id)],
  );
  const steps = new Map<string, { status: string; at: Date }[]>();
  for (const step of history.rows) {
    steps.set(step.operation_id, [...(steps.get(step.operation_id) ?? []), { status: step.status, at: step.changed_at }]);
  }
  const byClient = new Map<string, TraceOperation[]>();
  for (const row of rows.rows) {
    const operation: TraceOperation = {
      id: row.id,
      number: row.number,
      type: row.type,
      status: row.status,
      amount: row.amount_kop,
      createdAt: row.created_at,
      history: steps.get(row.id) ?? [],
    };
    byClient.set(row.client_id, [...(byClient.get(row.client_id) ?? []), operation]);
  }
  return byClient;
}

async function dailyLimitOf(db: Db, clientId: string): Promise<bigint> {
  const client = await db.query<{ tariff_code: string }>('SELECT tariff_code FROM clients WHERE id = $1', [clientId]);
  const tariff = await getTariff(db, (client.rows[0] as { tariff_code: string }).tariff_code);
  return effectiveDailyLimit(tariff.dailyPhoneLimit, await findDailyLimitOverride(db, clientId));
}

async function remainingToday(db: Db, clientId: string, limit: bigint, now: Date): Promise<bigint> {
  const used = (await loadPhoneTransferUsage(db, clientId, now)).usedTodayByMoscowDay;
  return limit > used ? limit - used : 0n;
}

export async function traceFacts(
  db: Db,
  rows: readonly { id: string; client_id: string }[],
  now: Date,
): Promise<Map<string, OperationTraceFacts>> {
  const out = new Map<string, OperationTraceFacts>();
  const clientIds = [...new Set(rows.map((row) => row.client_id))];
  if (!clientIds.length) return out;
  const siblings = await loadSiblings(db, clientIds);
  const limits = new Map<string, bigint>();
  const remaining = new Map<string, bigint>();
  for (const clientId of clientIds) {
    const limit = await dailyLimitOf(db, clientId);
    limits.set(clientId, limit);
    remaining.set(clientId, await remainingToday(db, clientId, limit, now));
  }
  for (const row of rows) {
    const own = siblings.get(row.client_id) ?? [];
    const operation = own.find((item) => item.id === row.id) as TraceOperation;
    const trace = limitTrace(operation, own, limits.get(row.client_id) as bigint);
    const left = remaining.get(row.client_id) as bigint;
    out.set(row.id, {
      wasOnReview: operation.history.some((step) => step.status === 'ON_REVIEW'),
      createdWhileOtherOnReview: hadOtherOnReview(operation, own),
      limitBeforeKop: trace ? toApiAmount(trace.beforeKop) : null,
      limitAfterKop: trace ? toApiAmount(trace.afterKop) : null,
      limitMarginKop: trace ? toApiAmount(trace.beforeKop) - toApiAmount(operation.amount) : null,
      limitBeforeRub: trace ? rubles(trace.beforeKop) : null,
      clientRemainingKop: toApiAmount(left),
      clientRemainingRub: rubles(left),
    });
  }
  return out;
}
