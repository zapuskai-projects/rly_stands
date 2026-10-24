import type { Pool } from 'pg';
import { fromApiAmount } from '../../accounts/money';
import type { BankClock } from '../../clock/bank-clock';
import { setPartnerWebhook } from '../../partners/partners.repository';
import { createQrRefund } from '../../qr/qr-refund.service';
import { badRequest, unprocessable } from '../../shared/errors';
import { isLoopbackWebhookHost, webhookUrlIssue, WEBHOOK_LOOPBACK_MESSAGE } from '../../webhooks/webhook-url';
import { listDeliveries, type DeliveryFilter } from '../../webhooks/webhooks.repository';
import type { Partner } from '../../partners/partners.repository';
import { cancelPartnerQr, createQr, getPartnerQr } from '../../qr/qr.service';
import { QR_DEFAULT_TTL_SECONDS } from '../../qr/qr-rules';
import { partnerQrDto, partnerRefundDto, webhookDeliveryDto } from '../dto-qr';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
}

interface CreateQrBody {
  orderId: string;
  amount: number;
  description: string;
  ttlSeconds?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const partnerOf = (ctx: HandlerContext): Partner => ctx.partner as Partner;
const qrIdOf = (ctx: HandlerContext): string => String(ctx.params.qrId);

export function partnerHandlers({ pool, clock }: Deps): Record<string, Handler> {
  return {
    createPartnerQr: async (ctx) => {
      const body = ctx.body as CreateQrBody;
      const description = body.description.trim();
      if (!description) {
        throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: 'body.description', message: 'Назначение платежа не может быть пустым' }]);
      }
      const { qr, replayed } = await createQr({ pool, clock }, partnerOf(ctx), {
        orderId: body.orderId,
        amount: fromApiAmount(body.amount),
        description,
        ttlSeconds: body.ttlSeconds ?? QR_DEFAULT_TTL_SECONDS,
        attemptLabel: ctx.attemptLabel,
      });
      return {
        status: replayed ? 200 : 201,
        body: partnerQrDto(qr, clock.now()),
        headers: replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
      };
    },
    getPartnerQr: async (ctx) => {
      const qr = await getPartnerQr({ pool, clock }, partnerOf(ctx), qrIdOf(ctx));
      return { status: 200, body: partnerQrDto(qr, clock.now()), operationId: qr.paidOperationId ?? undefined };
    },
    cancelPartnerQr: async (ctx) => {
      const qr = await cancelPartnerQr({ pool, clock }, partnerOf(ctx), qrIdOf(ctx));
      return { status: 200, body: partnerQrDto(qr, clock.now()) };
    },
    createPartnerQrRefund: async (ctx) => {
      const result = await createQrRefund({ pool, clock }, partnerOf(ctx), {
        qrId: qrIdOf(ctx),
        amount: fromApiAmount((ctx.body as { amount: number }).amount),
        idempotencyKey: String(ctx.headers['Idempotency-Key']),
        requestId: ctx.requestId,
        attemptLabel: ctx.attemptLabel,
      });
      return {
        status: result.replayed ? 200 : 201,
        body: partnerRefundDto(result),
        headers: result.replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        operationId: result.refund.operationId,
      };
    },
    setPartnerWebhook: async (ctx) => {
      const body = ctx.body as { url: string; secret: string };
      const issue = webhookUrlIssue(body.url);
      if (issue) throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: 'body.url', message: issue }]);
      if (isLoopbackWebhookHost(body.url)) throw unprocessable('WEBHOOK_URL_LOOPBACK', WEBHOOK_LOOPBACK_MESSAGE);
      await setPartnerWebhook(pool, partnerOf(ctx).id, body.url, body.secret);
      return { status: 200, body: { url: body.url, secretSet: true } };
    },
    listPartnerWebhookDeliveries: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const filter: DeliveryFilter = { partnerId: partnerOf(ctx).id };
      if (ctx.query.qrId) filter.qrId = String(ctx.query.qrId);
      if (ctx.query.event) filter.event = ctx.query.event as DeliveryFilter['event'];
      const { rows, total } = await listDeliveries(pool, filter, limit, offset);
      const offsetMs = clock.getOffsetMs();
      return { status: 200, body: { items: rows.map((row) => webhookDeliveryDto(row, offsetMs)), total, limit, offset } };
    },
  };
}
