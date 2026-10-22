import type { Pool } from 'pg';

export interface LedgerReport {
  mismatchedAccounts: string[];
  totalOfBalances: bigint;
  postingsWithoutPair: bigint;
}

export async function checkLedger(pool: Pool): Promise<LedgerReport> {
  const mismatches = await pool.query<{ number: string }>(
    `SELECT a.number FROM accounts a
     WHERE a.balance_kop <> COALESCE((SELECT SUM(CASE WHEN p.credit_account_id = a.id THEN p.amount_kop ELSE -p.amount_kop END)
                                      FROM postings p WHERE p.credit_account_id = a.id OR p.debit_account_id = a.id), 0)`,
  );
  const total = await pool.query<{ total: bigint }>('SELECT COALESCE(SUM(balance_kop), 0)::bigint AS total FROM accounts');
  const unpaired = await pool.query<{ total: bigint }>(
    'SELECT COUNT(*) AS total FROM postings WHERE debit_account_id IS NULL OR credit_account_id IS NULL',
  );
  return {
    mismatchedAccounts: mismatches.rows.map((row) => row.number),
    totalOfBalances: (total.rows[0] as { total: bigint }).total,
    postingsWithoutPair: (unpaired.rows[0] as { total: bigint }).total,
  };
}
