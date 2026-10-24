import type { Pool } from 'pg';
import type { BankClock } from '../../clock/bank-clock';
import type { ReleaseSource } from '../../release/release-source';
import { createQrPayment, lookupQr } from '../../qr/qr-payment.service';
import { qrPurchaseDto } from '../dto-qr';
import type { Handler, HandlerContext } from '../router';
import { loadOperationDto } from './transfers';

interface Deps {
  pool: Pool;
  clock: BankClock;
  releases: ReleaseSource;
}

interface QrPaymentBody {
  payload: string;
  accountId: string;
}

const clientIdOf = (ctx: HandlerContext): string => (ctx.session as { clientId: string }).clientId;

export function qrPaymentHandlers({ pool, clock, releases }: Deps): Record<string, Handler> {
  return {
    lookupQrPayment: async (ctx) => {
      const qr = await lookupQr({ pool, clock }, String(ctx.query.payload));
      return { status: 200, body: qrPurchaseDto(qr, clock.now()) };
    },
    createQrPayment: async (ctx) => {
      const clientId = clientIdOf(ctx);
      const body = ctx.body as QrPaymentBody;
      const result = await createQrPayment(
        { pool, clock },
        {
          clientId,
          idempotencyKey: String(ctx.headers['Idempotency-Key']),
          payload: body.payload,
          accountId: body.accountId,
          requestId: ctx.requestId,
          attemptLabel: ctx.attemptLabel,
        },
      );
      return {
        status: result.replayed ? 200 : 201,
        body: await loadOperationDto(pool, releases, clientId, result.operationId),
        headers: result.replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        operationId: result.operationId,
      };
    },
  };
}
