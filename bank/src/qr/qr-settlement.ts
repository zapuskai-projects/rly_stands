import { findSystemAccount, lockAccounts } from '../accounts/accounts.repository';
import { closeHold, postEntries } from '../accounts/ledger';
import type { PostingDraft } from '../accounts/postings-plan';
import type { BankClock } from '../clock/bank-clock';
import type { Db } from '../db/pool';
import { queueCompletionNotifications } from '../notifications/completion';
import { findPartnerById } from '../partners/partners.repository';
import { transitionOperation, type OperationRecord } from '../payments/operations.repository';
import { enqueueQrWebhook } from '../webhooks/webhook-events';
import { lockQr, markQrPaid } from './qr.repository';
import { merchantCommission } from './qr-rules';

export interface QrSettlementContext {
  clock: BankClock;
  requestId?: string;
  actor?: string;
}

export interface QrPaymentPostingsInput {
  payerAccountId: string;
  merchantAccountId: string;
  incomeAccountId: string;
  amount: bigint;
  commission: bigint;
  paymentDescription: string;
  commissionDescription: string;
}

export function planQrPaymentPostings(input: QrPaymentPostingsInput): PostingDraft[] {
  const postings: PostingDraft[] = [
    {
      debitAccountId: input.payerAccountId,
      creditAccountId: input.merchantAccountId,
      amount: input.amount,
      kind: 'TRANSFER',
      description: input.paymentDescription,
    },
  ];
  if (input.commission > 0n) {
    postings.push({
      debitAccountId: input.merchantAccountId,
      creditAccountId: input.incomeAccountId,
      amount: input.commission,
      kind: 'FEE',
      description: input.commissionDescription,
    });
  }
  return postings;
}

export async function settleQrPayment(tx: Db, context: QrSettlementContext, operation: OperationRecord): Promise<void> {
  const qr = operation.qrId ? await lockQr(tx, operation.qrId) : null;
  if (!qr) throw new Error(`Для операции ${operation.number} не найден QR-код`);
  const partner = await findPartnerById(tx, qr.partnerId);
  if (!partner) throw new Error(`Для QR-кода ${qr.id} не найден магазин`);
  const income = await findSystemAccount(tx, 'INCOME');
  await lockAccounts(tx, [operation.fromAccountId, partner.settlementAccountId, income.id]);
  const postedAt = context.clock.now();
  const commission = merchantCommission(operation.amount, partner.commissionBps);
  const postings = planQrPaymentPostings({
    payerAccountId: operation.fromAccountId,
    merchantAccountId: partner.settlementAccountId,
    incomeAccountId: income.id,
    amount: operation.amount,
    commission,
    paymentDescription: `Оплата по QR в «${partner.name}», операция ${operation.number}`,
    commissionDescription: `Комиссия за приём платежа по QR, операция ${operation.number}`,
  });
  await postEntries(tx, postings, { operationId: operation.id, postedAt });
  await closeHold(tx, operation.id, 'CAPTURED', postedAt);
  await transitionOperation(tx, operation.id, 'COMPLETED', {
    at: postedAt,
    requestId: context.requestId,
    actor: context.actor,
  });
  await markQrPaid(tx, qr.id, operation.id, commission, postedAt);
  await enqueueQrWebhook(tx, { partner, event: 'qr.paid', qr: { id: qr.id, orderId: qr.orderId, amount: qr.amount, refunded: qr.refunded }, operationId: operation.id, at: postedAt });
  await queueCompletionNotifications(tx, { ...operation, requestId: context.requestId ?? operation.requestId }, postedAt);
}
