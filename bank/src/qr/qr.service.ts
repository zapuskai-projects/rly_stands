import type { Pool } from 'pg';
import type { Kopecks } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction } from '../db/pool';
import type { Partner } from '../partners/partners.repository';
import { conflict, notFound } from '../shared/errors';
import {
  findPartnerQr,
  findQr,
  findQrByOrder,
  insertQrIfAbsent,
  markQrCancelled,
  type QrRecord,
} from './qr.repository';
import { cancelRefusal, qrExpiresAt } from './qr-rules';

export interface QrDeps {
  pool: Pool;
  clock: BankClock;
}

export interface CreateQrInput {
  orderId: string;
  amount: Kopecks;
  description: string;
  ttlSeconds: number;
  attemptLabel: string | null;
}

const qrNotFound = () => notFound('QR_NOT_FOUND', 'QR-код не найден');

export async function createQr(deps: QrDeps, partner: Partner, input: CreateQrInput): Promise<{ qr: QrRecord; replayed: boolean }> {
  return withTransaction(deps.pool, async (tx) => {
    const now = deps.clock.now();
    const createdId = await insertQrIfAbsent(tx, {
      partnerId: partner.id,
      orderId: input.orderId,
      amount: input.amount,
      description: input.description,
      ttlSeconds: input.ttlSeconds,
      attemptLabel: input.attemptLabel,
      createdAt: now,
      expiresAt: qrExpiresAt(now, input.ttlSeconds),
    });
    if (createdId) return { qr: (await findQr(tx, createdId)) as QrRecord, replayed: false };
    const existing = (await findQrByOrder(tx, partner.id, input.orderId)) as QrRecord;
    if (existing.amount !== input.amount) {
      throw conflict('ORDER_ID_REUSED', 'Заказ с таким orderId уже есть с другой суммой. Используйте новый orderId');
    }
    return { qr: existing, replayed: true };
  });
}

export async function getPartnerQr(deps: QrDeps, partner: Partner, qrId: string): Promise<QrRecord> {
  const qr = await findPartnerQr(deps.pool, partner.id, qrId);
  if (!qr) throw qrNotFound();
  return qr;
}

export async function cancelPartnerQr(deps: QrDeps, partner: Partner, qrId: string): Promise<QrRecord> {
  return withTransaction(deps.pool, async (tx) => {
    const qr = await findPartnerQr(tx, partner.id, qrId, true);
    if (!qr) throw qrNotFound();
    const now = deps.clock.now();
    const refusal = cancelRefusal(qr, now);
    if (refusal) throw conflict(refusal.code, refusal.message);
    if (qr.status === 'CANCELLED') return qr;
    await markQrCancelled(tx, qr.id, now);
    return (await findQr(tx, qr.id)) as QrRecord;
  });
}
