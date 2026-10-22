import { postEntries } from '../accounts/ledger';
import { moscowDayStart } from '../clock/moscow';
import type { Db } from '../db/pool';
import type { HistorySeed } from './personas';

const DAY_MS = 24 * 60 * 60 * 1000;

export function historyMoment(now: Date, daysAgo: number, hour: number, minute: number): Date {
  return new Date(moscowDayStart(now).getTime() - daysAgo * DAY_MS + (hour * 60 + minute) * 60_000);
}

export interface HistoryTarget {
  clientId: string;
  accountId: string;
  correspondentId: string;
}

export async function seedHistory(tx: Db, now: Date, target: HistoryTarget, items: readonly HistorySeed[]): Promise<void> {
  for (const item of items) {
    const at = historyMoment(now, item.daysAgo, item.hour, item.minute);
    const created = await tx.query<{ id: string; number: string }>(
      `INSERT INTO operations (client_id, type, route, status, from_account_id, recipient_phone, recipient_bank_code, recipient_name,
         amount_kop, fee_kop, request_id, created_at, updated_at, completed_at)
       VALUES ($1, 'PHONE_TRANSFER', 'SBP', 'COMPLETED', $2, $3, $4, $5, $6, 0, 'seed-history', $7, $7, $7) RETURNING id, number`,
      [target.clientId, target.accountId, item.recipientPhone, item.recipientBankCode, item.recipientName, item.amount, at],
    );
    const operation = created.rows[0] as { id: string; number: string };
    for (const [index, status] of ['CREATED', 'CHECKING', 'PROCESSING', 'COMPLETED'].entries()) {
      await tx.query('INSERT INTO operation_status_history (operation_id, status, changed_at) VALUES ($1, $2, $3)', [
        operation.id,
        status,
        new Date(at.getTime() + index * 400),
      ]);
    }
    await postEntries(
      tx,
      [
        {
          debitAccountId: target.accountId,
          creditAccountId: target.correspondentId,
          amount: item.amount,
          kind: 'TRANSFER',
          description: `Перевод по номеру телефона, операция ${operation.number}`,
        },
      ],
      { operationId: operation.id, postedAt: at },
    );
  }
}
