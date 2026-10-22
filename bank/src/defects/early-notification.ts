import type { Db } from '../db/pool';
import { queueCompletionNotifications } from '../notifications/completion';
import type { OperationRecord } from '../payments/operations.repository';
import { hasDefectMark, insertDefectMarks, loadActiveDefects } from './defects.repository';

export async function queueNotificationsBeforeCompletion(tx: Db, operation: OperationRecord, at: Date): Promise<void> {
  if (operation.route !== 'SBP' || !(await loadActiveDefects(tx)).has('notify-before-complete')) return;
  await queueCompletionNotifications(tx, operation, at);
  await insertDefectMarks(tx, operation.id, [{ code: 'notify-before-complete', details: { expected: 'COMPLETED', actual: 'PROCESSING' } }], at);
}

export async function wasNotifiedBeforeCompletion(tx: Db, operation: OperationRecord): Promise<boolean> {
  return operation.route === 'SBP' && hasDefectMark(tx, operation.id, 'notify-before-complete');
}
