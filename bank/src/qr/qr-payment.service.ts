import type { Pool } from 'pg';
import { findClientAccountById, lockAccounts, sumActiveHolds } from '../accounts/accounts.repository';
import { createHold } from '../accounts/ledger';
import { formatRubles } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { findClientById, lockClientForTransfers } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import { paymentCreatedMessage } from '../events/builders';
import { enqueueOutbox } from '../events/outbox.repository';
import { insertDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import type { DefectMark } from '../defects/catalog';
import { toMoscowIso } from '../clock/moscow';
import { findIdempotencyRecord, insertIdempotencyRecord, insertOperation, transitionOperation } from '../payments/operations.repository';
import { findPartnerById } from '../partners/partners.repository';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../shared/errors';
import { findQr, lockQr, setPendingPayment, type QrRecord } from './qr.repository';
import { hashQrPayment, paymentDecision, parseQrPayload } from './qr-rules';

export interface QrPaymentDeps {
  pool: Pool;
  clock: BankClock;
}

export interface CreateQrPaymentInput {
  clientId: string;
  idempotencyKey: string;
  payload: string;
  accountId: string;
  requestId: string;
  attemptLabel: string | null;
}

export interface CreateQrPaymentResult {
  operationId: string;
  replayed: boolean;
}

const ARREST_MESSAGE = 'По счёту наложен арест, расходные операции приостановлены';

function qrIdFromPayload(payload: string): string {
  const qrId = parseQrPayload(payload);
  if (!qrId) throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: 'body.payload', message: 'Содержимое не похоже на QR-код ЗапускБанка' }]);
  return qrId;
}

export async function lookupQr(deps: QrPaymentDeps, payload: string): Promise<QrRecord> {
  const qr = await findQr(deps.pool, qrIdFromPayload(payload));
  if (!qr) throw notFound('QR_NOT_FOUND', 'QR-код не найден');
  return qr;
}

function paymentMarks(code: 'qr-double-payment' | 'qr-expired-accepted' | undefined, qr: QrRecord, now: Date): DefectMark[] {
  if (code === 'qr-double-payment') {
    return [
      {
        code,
        details: {
          expected: 'QR_ALREADY_PAID',
          actual: 'ACCEPTED',
          qrId: qr.id,
          firstOperationId: qr.paidOperationId ?? qr.pendingOperationId,
          firstOperationNumber: qr.paidOperationNumber,
          firstStatus: qr.status === 'CREATED' ? 'PENDING' : qr.status,
        },
      },
    ];
  }
  if (code === 'qr-expired-accepted') {
    return [
      {
        code,
        details: {
          expected: 'QR_EXPIRED',
          actual: 'ACCEPTED',
          qrId: qr.id,
          expiresAt: toMoscowIso(qr.expiresAt),
          secondsAfterExpiry: Math.floor((now.getTime() - qr.expiresAt.getTime()) / 1000),
        },
      },
    ];
  }
  return [];
}

async function processQrPayment(tx: Db, deps: QrPaymentDeps, input: CreateQrPaymentInput, qrId: string): Promise<string> {
  const client = await findClientById(tx, input.clientId);
  if (!client || client.status !== 'ACTIVE') throw forbidden('CLIENT_BLOCKED', 'Операции клиента приостановлены');
  const qr = await lockQr(tx, qrId);
  if (!qr) throw notFound('QR_NOT_FOUND', 'QR-код не найден');
  const now = deps.clock.now();
  const defects = await loadActiveDefects(tx);
  const decision = paymentDecision(qr, now, { doublePayment: defects.has('qr-double-payment'), expiredAccepted: defects.has('qr-expired-accepted') });
  if (decision.refusal) throw conflict(decision.refusal.code, decision.refusal.message);
  const partner = await findPartnerById(tx, qr.partnerId);
  if (!partner) throw notFound('QR_NOT_FOUND', 'QR-код не найден');
  const shop = await findClientById(tx, partner.clientId);
  if (!shop || shop.status !== 'ACTIVE') throw unprocessable('RECIPIENT_NOT_FOUND', 'Магазин не принимает платежи');
  const sourceCandidate = await findClientAccountById(tx, input.clientId, input.accountId);
  if (!sourceCandidate) throw unprocessable('ACCOUNT_NOT_FOUND', 'Счёт списания не найден среди ваших счетов');
  if (sourceCandidate.id === partner.settlementAccountId) throw unprocessable('SAME_ACCOUNT', 'Нельзя оплатить покупку со счёта магазина');
  const locked = await lockAccounts(tx, [sourceCandidate.id, partner.settlementAccountId]);
  const source = locked.get(sourceCandidate.id) ?? sourceCandidate;
  if (locked.get(partner.settlementAccountId)?.status === 'CLOSED') throw unprocessable('RECIPIENT_NOT_FOUND', 'Магазин не принимает платежи');
  const arrested = source.status === 'ARRESTED';
  if (!arrested) {
    const held = (await sumActiveHolds(tx, [source.id])).get(source.id) ?? 0n;
    const available = source.balance - held;
    if (available < qr.amount) throw unprocessable('INSUFFICIENT_FUNDS', `Недостаточно средств на счёте. Доступно: ${formatRubles(available)}`);
  }

  const created = await insertOperation(tx, {
    clientId: client.id,
    type: 'QR_PAYMENT',
    route: 'INTERNAL',
    fromAccountId: source.id,
    toAccountId: partner.settlementAccountId,
    recipientPhone: null,
    recipientBankCode: null,
    recipientName: partner.name,
    amount: qr.amount,
    fee: 0n,
    comment: qr.description,
    attemptLabel: input.attemptLabel,
    requestId: input.requestId,
    qrId: qr.id,
    createdAt: now,
  });
  await insertIdempotencyRecord(tx, client.id, input.idempotencyKey, hashQrPayment(qr.id, source.id), created.id, now);
  if (!arrested) await insertDefectMarks(tx, created.id, paymentMarks(decision.defect?.code, qr, now), now);
  await enqueueOutbox(
    tx,
    paymentCreatedMessage({
      operationId: created.id,
      operationNumber: created.number,
      clientNumber: client.number,
      type: 'QR_PAYMENT',
      route: 'INTERNAL',
      amount: qr.amount,
      fee: 0n,
      fromAccount: source.number,
      recipientPhone: null,
      recipientBankCode: null,
      createdAt: now,
      requestId: input.requestId,
      qrId: qr.id,
    }),
  );
  await transitionOperation(tx, created.id, 'CHECKING', { at: deps.clock.now(), requestId: input.requestId });
  if (arrested) {
    await transitionOperation(tx, created.id, 'REJECTED', {
      at: deps.clock.now(),
      requestId: input.requestId,
      reasonCode: 'ACCOUNT_ARRESTED',
      comment: ARREST_MESSAGE,
    });
    return created.id;
  }
  await setPendingPayment(tx, qr.id, created.id);
  await createHold(tx, { accountId: source.id, operationId: created.id, amount: qr.amount, at: deps.clock.now() });
  return created.id;
}

export async function createQrPayment(deps: QrPaymentDeps, input: CreateQrPaymentInput): Promise<CreateQrPaymentResult> {
  const qrId = qrIdFromPayload(input.payload);
  return withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, input.clientId);
    const existing = await findIdempotencyRecord(tx, input.clientId, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== hashQrPayment(qrId, input.accountId)) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован с другим телом запроса');
      }
      return { operationId: existing.operationId, replayed: true };
    }
    return { operationId: await processQrPayment(tx, deps, input, qrId), replayed: false };
  });
}
