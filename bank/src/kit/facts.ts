import { sumActiveHolds } from '../accounts/accounts.repository';
import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { Db } from '../db/pool';
import { isTerminal, OPERATION_STATUSES } from '../payments/status';
import { findDecision } from '../antifraud/decisions.repository';
import { databaseReleaseSource } from '../release/release-source';
import { listDefectMarks } from '../defects/defects.repository';
import { ageSecondsOf, hasKopecks } from './operation-age';
import { traceFacts, type OperationTraceFacts } from './operation-trace';

const OPERATIONS_LIMIT = 500;
const REQUESTS_LIMIT = 1000;
const TERMINAL_STATUSES = OPERATION_STATUSES.filter(isTerminal);

interface OperationRow {
  id: string;
  client_id: string;
  number: string;
  phone: string;
  type: string;
  route: string;
  status: string;
  amount_kop: bigint;
  fee_kop: bigint;
  reject_code: string | null;
  recipient_phone: string | null;
  template_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface HistoryRow {
  operation_id: string;
  status: string;
  reason_code: string | null;
  changed_at: Date;
}

export interface OperationFilter {
  label?: string;
  phone?: string;
  status?: string;
}

export interface KitOperationFact extends OperationTraceFacts {
  id: string;
  number: string;
  clientPhone: string;
  type: string;
  route: string;
  status: string;
  amountKop: number;
  feeKop: number;
  reasonCode: string | null;
  recipientPhone: string | null;
  templateId?: string | null;
  createdAt: string;
  ageSeconds: number;
  hasKopecks: boolean;
  statusHistory: { status: string; at: string; reasonCode: string | null }[];
  antifraudScore: number | null;
  defectCodes: string[];
}

const SELECT_OPERATION = `
  SELECT o.id, o.client_id, o.number, c.phone, o.type, o.route, o.status, o.amount_kop, o.fee_kop, o.reject_code, o.recipient_phone, o.template_id, o.created_at, o.completed_at
  FROM operations o JOIN clients c ON c.id = o.client_id`;

async function withHistory(db: Db, rows: OperationRow[], now: Date): Promise<KitOperationFact[]> {
  const history = await db.query<HistoryRow>(
    'SELECT operation_id, status, reason_code, changed_at FROM operation_status_history WHERE operation_id = ANY($1::uuid[]) ORDER BY id',
    [rows.map((row) => row.id)],
  );
  const traces = await traceFacts(db, rows, now);
  const ids = rows.map((row) => row.id);
  const scores = await db.query<{ operation_id: string; score: number }>(
    'SELECT operation_id, score FROM antifraud_decisions WHERE operation_id = ANY($1::uuid[])',
    [ids],
  );
  const marks = await db.query<{ operation_id: string; defect_code: string }>(
    'SELECT operation_id, defect_code FROM defect_marks WHERE operation_id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  );
  const withTemplate = await databaseReleaseSource(db).atLeast('1.1');
  return rows.map((row) => {
    const steps = history.rows.filter((step) => step.operation_id === row.id);
    const reason = row.reject_code ?? [...steps].reverse().find((step) => step.reason_code !== null)?.reason_code ?? null;
    return {
      ...(traces.get(row.id) as OperationTraceFacts),
      id: row.id,
      number: row.number,
      clientPhone: row.phone,
      type: row.type,
      route: row.route,
      status: row.status,
      amountKop: toApiAmount(row.amount_kop),
      feeKop: toApiAmount(row.fee_kop),
      reasonCode: reason,
      recipientPhone: row.recipient_phone,
      ...(withTemplate ? { templateId: row.template_id } : {}),
      createdAt: toMoscowIso(row.created_at),
      ageSeconds: ageSecondsOf(row.created_at, now),
      hasKopecks: hasKopecks(row.amount_kop),
      statusHistory: steps.map((step) => ({ status: step.status, at: toMoscowIso(step.changed_at), reasonCode: step.reason_code })),
      antifraudScore: scores.rows.find((item) => item.operation_id === row.id)?.score ?? null,
      defectCodes: marks.rows.filter((item) => item.operation_id === row.id).map((item) => item.defect_code),
    };
  });
}

export async function listOperationFacts(db: Db, filter: OperationFilter, now: Date): Promise<KitOperationFact[]> {
  const rows = await db.query<OperationRow>(
    `${SELECT_OPERATION}
     WHERE ($1::text IS NULL OR c.phone = $1) AND ($2::text IS NULL OR o.status = $2)
       AND ($3::text IS NULL OR o.attempt_label = $3
            OR o.id IN (SELECT operation_id FROM request_log WHERE attempt_label = $3 AND operation_id IS NOT NULL))
     ORDER BY o.created_at, o.number LIMIT ${OPERATIONS_LIMIT}`,
    [filter.phone ?? null, filter.status ?? null, filter.label ?? null],
  );
  return withHistory(db, rows.rows, now);
}

export async function findOperationFact(db: Db, idOrNumber: string, now: Date) {
  const found = await db.query<OperationRow>(`${SELECT_OPERATION} WHERE o.id::text = $1 OR o.number = $1`, [idOrNumber]);
  const row = found.rows[0];
  if (!row) return null;
  const [fact] = await withHistory(db, [row], now);
  const postings = await db.query<{ debit: string; credit: string; amount_kop: bigint; kind: string }>(
    `SELECT da.number AS debit, ca.number AS credit, p.amount_kop, p.kind FROM postings p
     JOIN accounts da ON da.id = p.debit_account_id JOIN accounts ca ON ca.id = p.credit_account_id
     WHERE p.operation_id = $1 ORDER BY p.id`,
    [row.id],
  );
  const notifications = await db.query<{ channel: string; text: string; created_at: Date }>(
    'SELECT channel, text, created_at FROM notifications WHERE operation_id = $1 ORDER BY id',
    [row.id],
  );
  const decision = await findDecision(db, row.id);
  const marks = await listDefectMarks(db, row.id);
  return {
    ...fact,
    defects: marks.map((mark) => ({ code: mark.code, details: mark.details })),
    postings: postings.rows.map((posting) => ({ debit: posting.debit, credit: posting.credit, amountKop: toApiAmount(posting.amount_kop), kind: posting.kind })),
    antifraud: decision ? { score: decision.score, rules: decision.rules } : null,
    notifications: notifications.rows.map((item) => ({
      channel: item.channel,
      text: item.text,
      createdAt: toMoscowIso(item.created_at),
      beforeCompletion: row.completed_at === null || item.created_at < row.completed_at,
    })),
  };
}

interface LedgerRow {
  id: string;
  number: string;
  balance_kop: bigint;
  postings_sum: bigint;
}

const LEDGER_SELECT = `
  SELECT a.id, a.number, a.balance_kop,
         COALESCE((SELECT SUM(CASE WHEN p.credit_account_id = a.id THEN p.amount_kop ELSE -p.amount_kop END)
                   FROM postings p WHERE p.credit_account_id = a.id OR p.debit_account_id = a.id), 0)::bigint AS postings_sum
  FROM accounts a`;

const ledgerFact = (row: LedgerRow) => ({
  account: row.number,
  balanceKop: toApiAmount(row.balance_kop),
  postingsSumKop: toApiAmount(row.postings_sum),
});

export async function findLedgerFact(db: Db, account: string) {
  const result = await db.query<LedgerRow>(`${LEDGER_SELECT} WHERE a.number = $1`, [account]);
  const row = result.rows[0];
  if (!row) return null;
  const holds = (await sumActiveHolds(db, [row.id])).get(row.id) ?? 0n;
  return { ...ledgerFact(row), consistent: row.balance_kop === row.postings_sum, holdsKop: toApiAmount(holds) };
}

export async function listInconsistentAccounts(db: Db) {
  const result = await db.query<LedgerRow>(
    `SELECT * FROM (${LEDGER_SELECT} WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = a.client_id AND c.technical)) l
     WHERE l.balance_kop <> l.postings_sum ORDER BY l.number`,
  );
  return result.rows.map(ledgerFact);
}

export async function listRequestFacts(db: Db, label: string) {
  const result = await db.query<{
    method: string;
    path: string;
    status: number;
    idempotency_key: string | null;
    requested_at: Date;
    error_code: string | null;
    operation_id: string | null;
    replayed: boolean;
    terminal_at: Date | null;
  }>(
    `SELECT r.method, r.path, r.status, r.idempotency_key, r.requested_at, r.error_code, r.operation_id, r.replayed,
            (SELECT MIN(h.changed_at) FROM operation_status_history h WHERE h.operation_id = r.operation_id AND h.status = ANY($2::text[])) AS terminal_at
     FROM request_log r WHERE r.attempt_label = $1 ORDER BY r.id LIMIT ${REQUESTS_LIMIT}`,
    [label, TERMINAL_STATUSES],
  );
  return result.rows.map((row) => ({
    method: row.method,
    path: row.path,
    status: row.status,
    responseStatus: row.status,
    errorCode: row.error_code,
    operationId: row.operation_id,
    replayed: row.replayed,
    idempotencyKey: row.idempotency_key,
    at: toMoscowIso(row.requested_at),
    operationTerminalAt: row.terminal_at ? toMoscowIso(row.terminal_at) : null,
  }));
}
