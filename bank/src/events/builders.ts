import { randomUUID } from 'node:crypto';
import { toApiAmount, type Kopecks } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { AutopaymentExecutedPayload, NotificationMessage, PaymentCreatedPayload, StatusChangedPayload } from './payloads';
import type { OutboxMessage } from './outbox.repository';
import { getTopics, NOTIFICATION_ROUTING_KEY } from './topics';

const KOPECKS_IN_RUBLE = 100;

export function amountInRubles(amount: Kopecks): number {
  return toApiAmount(amount) / KOPECKS_IN_RUBLE;
}

export interface CreatedEventInput {
  operationId: string;
  operationNumber: string;
  clientNumber: string;
  type: PaymentCreatedPayload['type'];
  route: PaymentCreatedPayload['route'];
  amount: Kopecks;
  fee: Kopecks;
  fromAccount: string;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  createdAt: Date;
  requestId: string;
  amountInRubles?: boolean;
  templateId?: string | null;
  qrId?: string | null;
}

export function paymentCreatedMessage(input: CreatedEventInput): OutboxMessage {
  const payload: PaymentCreatedPayload = {
    eventId: randomUUID(),
    operationId: input.operationId,
    operationNumber: input.operationNumber,
    clientNumber: input.clientNumber,
    type: input.type,
    route: input.route,
    amount: input.amountInRubles ? amountInRubles(input.amount) : toApiAmount(input.amount),
    fee: toApiAmount(input.fee),
    currency: 'RUB',
    fromAccount: input.fromAccount,
    recipientPhone: input.recipientPhone,
    recipientBankCode: input.recipientBankCode,
    ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
    ...(input.qrId === undefined ? {} : { qrId: input.qrId }),
    createdAt: toMoscowIso(input.createdAt),
  };
  return {
    destination: 'KAFKA',
    topic: getTopics().paymentsCreated,
    key: input.clientNumber,
    headers: { operationId: input.operationId, requestId: input.requestId },
    payload,
    createdAt: input.createdAt,
  };
}

export interface StatusEventInput {
  operationId: string;
  operationNumber: string;
  clientNumber: string;
  previousStatus: string;
  status: string;
  reasonCode: string | null;
  changedAt: Date;
  requestId: string;
}

export function statusChangedMessage(input: StatusEventInput): OutboxMessage {
  const payload: StatusChangedPayload = {
    eventId: randomUUID(),
    operationId: input.operationId,
    operationNumber: input.operationNumber,
    clientNumber: input.clientNumber,
    previousStatus: input.previousStatus,
    status: input.status,
    reasonCode: input.reasonCode,
    changedAt: toMoscowIso(input.changedAt),
  };
  return {
    destination: 'KAFKA',
    topic: getTopics().statusChanged,
    key: input.clientNumber,
    headers: { operationId: input.operationId, requestId: input.requestId },
    payload,
    createdAt: input.changedAt,
  };
}

export interface AutopaymentEventInput {
  autopaymentId: string;
  runId: string;
  clientNumber: string;
  runDate: string;
  cycleDate: string;
  attempt: number;
  outcome: AutopaymentExecutedPayload['outcome'];
  operationId: string | null;
  operationNumber: string | null;
  reasonCode: string | null;
  amount: Kopecks;
  finishedAt: Date;
  requestId: string;
}

export function autopaymentExecutedMessage(input: AutopaymentEventInput): OutboxMessage {
  const payload: AutopaymentExecutedPayload = {
    eventId: randomUUID(),
    autopaymentId: input.autopaymentId,
    runId: input.runId,
    clientNumber: input.clientNumber,
    runDate: input.runDate,
    cycleDate: input.cycleDate,
    attempt: input.attempt,
    outcome: input.outcome,
    operationId: input.operationId,
    operationNumber: input.operationNumber,
    reasonCode: input.reasonCode,
    amount: toApiAmount(input.amount),
    currency: 'RUB',
    finishedAt: toMoscowIso(input.finishedAt),
  };
  return {
    destination: 'KAFKA',
    topic: getTopics().autopaymentsExecuted,
    key: input.clientNumber,
    headers: { autopaymentId: input.autopaymentId, requestId: input.requestId, ...(input.operationId ? { operationId: input.operationId } : {}) },
    payload,
    createdAt: input.finishedAt,
  };
}

export interface NotificationInput {
  operationId: string | null;
  requestId: string;
  clientId: string;
  phone: string;
  channel: NotificationMessage['channel'];
  kind: NotificationMessage['kind'];
  text: string;
  createdAt: Date;
  autopaymentId?: string;
}

export function notificationOutboxMessage(input: NotificationInput): OutboxMessage {
  const payload: NotificationMessage = {
    messageId: randomUUID(),
    operationId: input.operationId,
    clientId: input.clientId,
    phone: input.phone,
    channel: input.channel,
    kind: input.kind,
    text: input.text,
    createdAt: toMoscowIso(input.createdAt),
    ...(input.autopaymentId ? { autopaymentId: input.autopaymentId } : {}),
  };
  return {
    destination: 'RABBIT',
    topic: getTopics().notificationsExchange,
    key: NOTIFICATION_ROUTING_KEY,
    headers: { requestId: input.requestId, ...(input.operationId ? { operationId: input.operationId } : {}), ...(input.autopaymentId ? { autopaymentId: input.autopaymentId } : {}) },
    payload,
    createdAt: input.createdAt,
  };
}
