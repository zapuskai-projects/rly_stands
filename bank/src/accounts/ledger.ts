import type { Db } from '../db/pool';
import { balanceDeltas, type PostingDraft } from './postings-plan';
import type { Kopecks } from './money';

export interface PostingMeta {
  operationId: string | null;
  postedAt: Date;
}

export async function postEntries(tx: Db, drafts: readonly PostingDraft[], meta: PostingMeta): Promise<void> {
  for (const draft of drafts) {
    await tx.query(
      `INSERT INTO postings (operation_id, debit_account_id, credit_account_id, amount_kop, kind, description, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [meta.operationId, draft.debitAccountId, draft.creditAccountId, draft.amount, draft.kind, draft.description, meta.postedAt],
    );
  }
  const deltas = [...balanceDeltas(drafts)].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [accountId, delta] of deltas) {
    await tx.query('UPDATE accounts SET balance_kop = balance_kop + $1 WHERE id = $2', [delta, accountId]);
  }
}

export interface NewHold {
  accountId: string;
  operationId: string;
  amount: Kopecks;
  at: Date;
}

export async function createHold(tx: Db, hold: NewHold): Promise<void> {
  await tx.query(
    'INSERT INTO holds (account_id, operation_id, amount_kop, created_at) VALUES ($1, $2, $3, $4)',
    [hold.accountId, hold.operationId, hold.amount, hold.at],
  );
}

export async function closeHold(tx: Db, operationId: string, status: 'CAPTURED' | 'RELEASED', at: Date): Promise<void> {
  await tx.query("UPDATE holds SET status = $2, closed_at = $3 WHERE operation_id = $1 AND status = 'ACTIVE'", [
    operationId,
    status,
    at,
  ]);
}
