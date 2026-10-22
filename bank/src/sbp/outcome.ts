import type { Pool } from 'pg';
import { findSystemAccount } from '../accounts/accounts.repository';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction } from '../db/pool';
import { toApiAmount } from '../accounts/money';
import { insertDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import { failOperation, refundOperation, requireLockedOperation, settleOperation, type LifecycleContext } from '../payments/lifecycle';
import type { SbpAnswer } from './gateway';

export interface SbpDeps {
  pool: Pool;
  clock: BankClock;
}

type SbpState = 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE' | 'TIMED_OUT';

const STATE_BY_ANSWER: Record<SbpAnswer['kind'], SbpState> = {
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  UNAVAILABLE: 'UNAVAILABLE',
  TIMEOUT: 'TIMED_OUT',
};

export async function applySbpOutcome(deps: SbpDeps, operationId: string, answer: SbpAnswer, requestId: string): Promise<boolean> {
  const context: LifecycleContext = { clock: deps.clock, requestId, actor: 'SBP' };
  return withTransaction(deps.pool, async (tx) => {
    const operation = await requireLockedOperation(tx, operationId);
    const transfer = await tx.query<{ state: string }>('SELECT state FROM sbp_transfers WHERE operation_id = $1 FOR UPDATE', [operationId]);
    if (operation.status !== 'PROCESSING' || transfer.rows[0]?.state !== 'SENT') return false;
    if (answer.kind === 'ACCEPTED') {
      const correspondent = await findSystemAccount(tx, 'CORRESPONDENT');
      await settleOperation(tx, context, operation, correspondent.id);
    } else if (answer.kind === 'REJECTED') {
      await failOperation(tx, context, operation, { code: 'SBP_REJECTED', message: 'Банк получателя отклонил перевод' });
    } else if (answer.kind === 'UNAVAILABLE') {
      await failOperation(tx, context, operation, { code: 'SBP_UNAVAILABLE', message: 'Система быстрых платежей недоступна' });
    } else if ((await loadActiveDefects(tx)).has('sbp-timeout-stuck')) {
      const held = toApiAmount(operation.amount + operation.fee);
      await insertDefectMarks(tx, operationId, [{ code: 'sbp-timeout-stuck', details: { expected: 'REFUNDED', actual: operation.status, held } }], deps.clock.now());
    } else {
      await refundOperation(tx, context, operation, { code: 'SBP_TIMEOUT', message: 'СБП не ответила вовремя, деньги возвращены на счёт' });
    }
    const reason = 'reason' in answer ? answer.reason : answer.kind === 'ACCEPTED' ? answer.reference : null;
    await tx.query('UPDATE sbp_transfers SET state = $2, answered_at = now(), reason = $3 WHERE operation_id = $1', [
      operationId,
      STATE_BY_ANSWER[answer.kind],
      reason,
    ]);
    return true;
  });
}
