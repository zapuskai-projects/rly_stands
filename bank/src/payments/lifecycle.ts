import { findSystemAccount, lockAccounts } from '../accounts/accounts.repository';
import { closeHold, postEntries } from '../accounts/ledger';
import { planTransferPostings, type PostingDraft } from '../accounts/postings-plan';
import type { BankClock } from '../clock/bank-clock';
import type { Db } from '../db/pool';
import { queueNotificationsBeforeCompletion, wasNotifiedBeforeCompletion } from '../defects/early-notification';
import { queueCompletionNotifications } from '../notifications/completion';
import { clearPendingPayment } from '../qr/qr.repository';
import { settleQrPayment } from '../qr/qr-settlement';
import { clearOperationFee, lockOperation, transitionOperation, type OperationRecord } from './operations.repository';

export interface LifecycleContext {
  clock: BankClock;
  requestId?: string;
  actor?: string;
}

export interface Reason {
  code: string;
  message: string;
}

function describeTransfer(operation: OperationRecord): string {
  return operation.type === 'OWN_TRANSFER'
    ? `Перевод между своими счетами, операция ${operation.number}`
    : `Перевод по номеру телефона, операция ${operation.number}`;
}

function stepOptions(context: LifecycleContext, at: Date, reason?: Reason) {
  return { at, reasonCode: reason?.code, comment: reason?.message, requestId: context.requestId, actor: context.actor };
}

function withRequestId(context: LifecycleContext, operation: OperationRecord): OperationRecord {
  return { ...operation, requestId: context.requestId ?? operation.requestId };
}

export async function requireLockedOperation(tx: Db, operationId: string): Promise<OperationRecord> {
  const operation = await lockOperation(tx, operationId);
  if (!operation) throw new Error(`Операция ${operationId} не найдена`);
  return operation;
}

export async function settleOperation(tx: Db, context: LifecycleContext, operation: OperationRecord, creditAccountId: string): Promise<void> {
  const income = await findSystemAccount(tx, 'INCOME');
  await lockAccounts(tx, [operation.fromAccountId, creditAccountId, income.id]);
  const postedAt = context.clock.now();
  const postings = planTransferPostings({
    fromAccountId: operation.fromAccountId,
    creditAccountId,
    incomeAccountId: income.id,
    amount: operation.amount,
    fee: operation.fee,
    transferDescription: describeTransfer(operation),
    feeDescription: `Комиссия за перевод, операция ${operation.number}`,
  });
  await postEntries(tx, postings, { operationId: operation.id, postedAt });
  await closeHold(tx, operation.id, 'CAPTURED', postedAt);
  await transitionOperation(tx, operation.id, 'COMPLETED', stepOptions(context, postedAt));
  if (!(await wasNotifiedBeforeCompletion(tx, operation))) {
    await queueCompletionNotifications(tx, withRequestId(context, operation), postedAt);
  }
}

export async function beginProcessing(tx: Db, context: LifecycleContext, operation: OperationRecord): Promise<'COMPLETED' | 'SENT_TO_SBP'> {
  await transitionOperation(tx, operation.id, 'PROCESSING', stepOptions(context, context.clock.now()));
  if (operation.type === 'QR_PAYMENT') {
    await settleQrPayment(tx, context, operation);
    return 'COMPLETED';
  }
  if (operation.route === 'INTERNAL' && operation.toAccountId) {
    await settleOperation(tx, context, operation, operation.toAccountId);
    return 'COMPLETED';
  }
  const at = context.clock.now();
  await tx.query('INSERT INTO sbp_transfers (operation_id, created_at) VALUES ($1, $2)', [operation.id, at]);
  await queueNotificationsBeforeCompletion(tx, withRequestId(context, operation), at);
  return 'SENT_TO_SBP';
}

async function dropWithoutDebit(
  tx: Db,
  context: LifecycleContext,
  operation: OperationRecord,
  status: 'REJECTED' | 'FAILED',
  reason: Reason,
): Promise<void> {
  const at = context.clock.now();
  await closeHold(tx, operation.id, 'RELEASED', at);
  await clearOperationFee(tx, operation.id);
  if (operation.qrId) await clearPendingPayment(tx, operation.id);
  await transitionOperation(tx, operation.id, status, stepOptions(context, at, reason));
}

export function rejectOperation(tx: Db, context: LifecycleContext, operation: OperationRecord, reason: Reason): Promise<void> {
  return dropWithoutDebit(tx, context, operation, 'REJECTED', reason);
}

export function failOperation(tx: Db, context: LifecycleContext, operation: OperationRecord, reason: Reason): Promise<void> {
  return dropWithoutDebit(tx, context, operation, 'FAILED', reason);
}

export async function refundOperation(tx: Db, context: LifecycleContext, operation: OperationRecord, reason: Reason): Promise<void> {
  const correspondent = await findSystemAccount(tx, 'CORRESPONDENT');
  await lockAccounts(tx, [operation.fromAccountId, correspondent.id]);
  const at = context.clock.now();
  const postings: PostingDraft[] = [
    {
      debitAccountId: operation.fromAccountId,
      creditAccountId: correspondent.id,
      amount: operation.amount,
      kind: 'TRANSFER',
      description: describeTransfer(operation),
    },
    {
      debitAccountId: correspondent.id,
      creditAccountId: operation.fromAccountId,
      amount: operation.amount,
      kind: 'REFUND',
      description: `Возврат перевода, операция ${operation.number}`,
    },
  ];
  await postEntries(tx, postings, { operationId: operation.id, postedAt: at });
  await closeHold(tx, operation.id, 'CAPTURED', at);
  await clearOperationFee(tx, operation.id);
  await transitionOperation(tx, operation.id, 'REFUNDED', stepOptions(context, at, reason));
}
