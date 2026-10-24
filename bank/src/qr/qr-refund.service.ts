import type { Pool } from 'pg';
import { findClientAccountById, lockAccounts, sumActiveHolds } from '../accounts/accounts.repository';
import { postEntries } from '../accounts/ledger';
import { formatRubles, toApiAmount, type Kopecks } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { findClientById } from '../clients/clients.repository';
import { shortName } from '../clients/names';
import { withTransaction, type Db } from '../db/pool';
import { paymentCreatedMessage } from '../events/builders';
import { enqueueOutbox } from '../events/outbox.repository';
import { loadContact, queuePair } from '../notifications/queue';
import { qrRefundTexts } from '../notifications/texts';
import type { Partner } from '../partners/partners.repository';
import { findOperationOfAnyClient, insertOperation, transitionOperation } from '../payments/operations.repository';
import { evaluateRejection } from '../payments/rejection';
import { conflict, notFound, unprocessable } from '../shared/errors';
import { insertDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import { enqueueQrWebhook } from '../webhooks/webhook-events';
import { applyQrRefund, findPartnerQr, type QrRecord } from './qr.repository';
import { findRefundByKey, insertRefund, type RefundRecord } from './qr-refunds.repository';
import { hashQrRefund, isPaidStatus, refundableAmount } from './qr-rules';

export interface QrRefundDeps {
  pool: Pool;
  clock: BankClock;
}

export interface CreateRefundInput {
  qrId: string;
  amount: Kopecks;
  idempotencyKey: string;
  requestId: string;
  attemptLabel: string | null;
}

export interface RefundResult {
  refund: RefundRecord;
  qr: QrRecord;
  replayed: boolean;
}

async function checkRefundable(tx: Db, partner: Partner, qr: QrRecord, amount: Kopecks, allowOverpayment: boolean): Promise<boolean> {
  if (!isPaidStatus(qr.status) && qr.status !== 'REFUNDED') throw conflict('QR_NOT_PAID', 'QR-код не оплачен, возвращать нечего');
  const remaining = refundableAmount(qr);
  const exceeds = amount > remaining;
  if (exceeds && !allowOverpayment) {
    throw unprocessable('REFUND_EXCEEDS_PAYMENT', `Сумма возвратов не может быть больше оплаты. Можно вернуть не больше ${formatRubles(remaining)}`);
  }
  const merchant = await findClientById(tx, partner.clientId);
  if (!merchant || merchant.status !== 'ACTIVE') throw unprocessable('CLIENT_BLOCKED', 'Операции магазина приостановлены');
  const settlement = (await lockAccounts(tx, [partner.settlementAccountId])).get(partner.settlementAccountId);
  const arrest = settlement
    ? evaluateRejection({ type: 'OWN_TRANSFER', route: 'INTERNAL', accountStatus: settlement.status, clientResident: true, amount, dailyLimit: 0n, usedToday: 0n })
    : null;
  if (arrest) throw unprocessable(arrest.code, arrest.message);
  const held = (await sumActiveHolds(tx, [partner.settlementAccountId])).get(partner.settlementAccountId) ?? 0n;
  if (!settlement || settlement.balance - held < amount) {
    throw unprocessable('INSUFFICIENT_FUNDS', 'На расчётном счёте магазина недостаточно средств для возврата');
  }
  return exceeds;
}

async function processRefund(tx: Db, deps: QrRefundDeps, partner: Partner, qr: QrRecord, input: CreateRefundInput, overpaid: boolean): Promise<RefundRecord> {
  const paid = qr.paidOperationId ? await findOperationOfAnyClient(tx, qr.paidOperationId) : null;
  const payer = paid ? await loadContact(tx, paid.clientId) : null;
  const merchant = await findClientById(tx, partner.clientId);
  if (!paid || !payer || !merchant) throw new Error(`У оплаченного QR-кода ${qr.id} нет операции оплаты`);
  const payerAccount = await findClientAccountById(tx, paid.clientId, paid.fromAccountId);
  const toAccountId = payerAccount?.id ?? paid.fromAccountId;
  await lockAccounts(tx, [partner.settlementAccountId, toAccountId]);
  const now = deps.clock.now();
  const created = await insertOperation(tx, {
    clientId: merchant.id,
    type: 'QR_REFUND',
    route: 'INTERNAL',
    fromAccountId: partner.settlementAccountId,
    toAccountId,
    recipientPhone: null,
    recipientBankCode: null,
    recipientName: shortName(payer.fullName),
    amount: input.amount,
    fee: 0n,
    comment: `Возврат по заказу ${qr.orderId}`,
    attemptLabel: input.attemptLabel,
    requestId: input.requestId,
    qrId: qr.id,
    createdAt: now,
  });
  await enqueueOutbox(
    tx,
    paymentCreatedMessage({
      operationId: created.id,
      operationNumber: created.number,
      clientNumber: merchant.number,
      type: 'QR_REFUND',
      route: 'INTERNAL',
      amount: input.amount,
      fee: 0n,
      fromAccount: partner.settlementAccountNumber,
      recipientPhone: null,
      recipientBankCode: null,
      createdAt: now,
      requestId: input.requestId,
      qrId: qr.id,
    }),
  );
  if (overpaid) {
    await insertDefectMarks(
      tx,
      created.id,
      [
        {
          code: 'refund-over-amount',
          details: {
            expected: 'REFUND_EXCEEDS_PAYMENT',
            actual: 'ACCEPTED',
            qrId: qr.id,
            paidAmount: toApiAmount(qr.amount),
            refundedBefore: toApiAmount(qr.refunded),
            requested: toApiAmount(input.amount),
            refundedAfter: toApiAmount(qr.refunded + input.amount),
          },
        },
      ],
      now,
    );
  }
  const step = { requestId: input.requestId };
  await transitionOperation(tx, created.id, 'CHECKING', { ...step, at: deps.clock.now() });
  await transitionOperation(tx, created.id, 'PROCESSING', { ...step, at: deps.clock.now() });
  const postedAt = deps.clock.now();
  await postEntries(
    tx,
    [
      {
        debitAccountId: partner.settlementAccountId,
        creditAccountId: toAccountId,
        amount: input.amount,
        kind: 'REFUND',
        description: `Возврат оплаты по QR из «${partner.name}», операция ${created.number}`,
      },
    ],
    { operationId: created.id, postedAt },
  );
  await transitionOperation(tx, created.id, 'COMPLETED', { ...step, at: postedAt });
  const refundId = await insertRefund(tx, {
    qrId: qr.id,
    partnerId: partner.id,
    operationId: created.id,
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
    requestHash: hashQrRefund(qr.id, input.amount),
    createdAt: postedAt,
  });
  await applyQrRefund(tx, qr.id, input.amount);
  await queuePair(tx, {
    operationId: created.id,
    requestId: input.requestId,
    contact: payer,
    kind: 'TRANSFER_RECEIVED',
    texts: qrRefundTexts({ amount: input.amount, operationNumber: created.number, merchantName: partner.name }),
    at: postedAt,
  });
  await enqueueQrWebhook(tx, {
    partner,
    event: 'qr.refunded',
    qr: { id: qr.id, orderId: qr.orderId, amount: qr.amount, refunded: qr.refunded + input.amount },
    operationId: created.id,
    at: postedAt,
  });
  return { id: refundId, qrId: qr.id, operationId: created.id, operationNumber: created.number, amount: input.amount, requestHash: hashQrRefund(qr.id, input.amount), createdAt: postedAt };
}

export async function createQrRefund(deps: QrRefundDeps, partner: Partner, input: CreateRefundInput): Promise<RefundResult> {
  return withTransaction(deps.pool, async (tx) => {
    const qr = await findPartnerQr(tx, partner.id, input.qrId, true);
    if (!qr) throw notFound('QR_NOT_FOUND', 'QR-код не найден');
    const existing = await findRefundByKey(tx, partner.id, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== hashQrRefund(qr.id, input.amount)) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован с другим запросом');
      }
      return { refund: existing, qr, replayed: true };
    }
    const defects = await loadActiveDefects(tx);
    const overpaid = await checkRefundable(tx, partner, qr, input.amount, defects.has('refund-over-amount'));
    const refund = await processRefund(tx, deps, partner, qr, input, overpaid);
    const updated = (await findPartnerQr(tx, partner.id, qr.id)) as QrRecord;
    return { refund, qr: updated, replayed: false };
  });
}
