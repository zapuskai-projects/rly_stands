import type { Db } from '../db/pool';
import type { Account } from './accounts.repository';
import type { Kopecks } from './money';

export type EntryDirection = 'DEBIT' | 'CREDIT';

export interface StatementEntry {
  id: number;
  postedAt: Date;
  direction: EntryDirection;
  amount: Kopecks;
  description: string;
  operationId: string | null;
  balanceAfter: Kopecks;
}

export interface StatementData {
  openingBalance: Kopecks;
  closingBalance: Kopecks;
  totalDebit: Kopecks;
  totalCredit: Kopecks;
  entries: StatementEntry[];
}

interface PostingRow {
  id: bigint;
  posted_at: Date;
  amount_kop: bigint;
  description: string;
  operation_id: string | null;
  is_debit: boolean;
}

export async function balanceFromPostings(db: Db, accountId: string, before: Date | null): Promise<Kopecks> {
  const result = await db.query<{ balance: bigint }>(
    `SELECT COALESCE(SUM(CASE WHEN credit_account_id = $1 THEN amount_kop ELSE -amount_kop END), 0)::bigint AS balance
     FROM postings
     WHERE (credit_account_id = $1 OR debit_account_id = $1) AND ($2::timestamptz IS NULL OR posted_at < $2)`,
    [accountId, before],
  );
  return (result.rows[0] as { balance: bigint }).balance;
}

export async function buildStatement(db: Db, account: Account, from: Date, toExclusive: Date): Promise<StatementData> {
  const openingBalance = await balanceFromPostings(db, account.id, from);
  const result = await db.query<PostingRow>(
    `SELECT id, posted_at, amount_kop, description, operation_id, (debit_account_id = $1) AS is_debit
     FROM postings
     WHERE (credit_account_id = $1 OR debit_account_id = $1) AND posted_at >= $2 AND posted_at < $3
     ORDER BY posted_at, id`,
    [account.id, from, toExclusive],
  );
  let running = openingBalance;
  let totalDebit = 0n;
  let totalCredit = 0n;
  const entries = result.rows.map((row): StatementEntry => {
    const direction: EntryDirection = row.is_debit ? 'DEBIT' : 'CREDIT';
    if (row.is_debit) {
      running -= row.amount_kop;
      totalDebit += row.amount_kop;
    } else {
      running += row.amount_kop;
      totalCredit += row.amount_kop;
    }
    return {
      id: Number(row.id),
      postedAt: row.posted_at,
      direction,
      amount: row.amount_kop,
      description: row.description,
      operationId: row.operation_id,
      balanceAfter: running,
    };
  });
  return { openingBalance, closingBalance: running, totalDebit, totalCredit, entries };
}
