import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import { hasSuccessfulTransferTo, loadUsualAmounts } from '../payments/operations.repository';
import { LIMIT_COUNTED_STATUSES } from '../payments/status';
import type { PaymentFacts } from './scoring';

export interface AwaitingPayment {
  createdAt: Date;
  amount: Kopecks;
  facts: PaymentFacts;
}

interface OperationHead {
  status: string;
  type: string;
  client_id: string;
  number: string;
  recipient_phone: string | null;
  recipient_bank_code: string | null;
  created_at: Date;
  amount_kop: Kopecks;
}

export async function loadAwaitingPayment(db: Db, operationId: string): Promise<AwaitingPayment | null> {
  const head = await db.query<OperationHead>(
    'SELECT status, type, client_id, number, recipient_phone, recipient_bank_code, created_at, amount_kop FROM operations WHERE id = $1',
    [operationId],
  );
  const operation = head.rows[0];
  if (!operation || operation.status !== 'CHECKING') return null;
  const before = { createdAt: operation.created_at, number: operation.number };
  const paymentType = operation.type === 'QR_PAYMENT' ? 'QR_PAYMENT' : 'PHONE_TRANSFER';
  const recipientKnown =
    paymentType === 'QR_PAYMENT' || (await hasSuccessfulTransferTo(db, operation.client_id, operation.recipient_phone, operation.recipient_bank_code, before));
  const usual = await loadUsualAmounts(db, operation.client_id, before, paymentType);
  const burst = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM operations
     WHERE client_id = $1 AND type = $5 AND status = ANY($2::text[]) AND (created_at, number) < ($3, $4)
       AND created_at >= $3::timestamptz - interval '1 hour'`,
    [operation.client_id, [...LIMIT_COUNTED_STATUSES], operation.created_at, operation.number, paymentType],
  );
  return {
    createdAt: operation.created_at,
    amount: operation.amount_kop,
    facts: {
      recipientKnown,
      priorTransfers: { count: usual.count, totalAmount: usual.total },
      priorInLastHour: (burst.rows[0] as { count: number }).count,
    },
  };
}
