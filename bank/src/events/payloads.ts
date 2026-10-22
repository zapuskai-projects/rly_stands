export type AntifraudDecision = 'APPROVE' | 'REVIEW' | 'REJECT';

export interface RuleHit {
  code: string;
  points: number;
}

export interface PaymentCreatedPayload {
  eventId: string;
  operationId: string;
  operationNumber: string;
  clientNumber: string;
  type: 'OWN_TRANSFER' | 'PHONE_TRANSFER';
  route: 'INTERNAL' | 'SBP';
  amount: number;
  fee: number;
  currency: 'RUB';
  fromAccount: string;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  createdAt: string;
}

export interface StatusChangedPayload {
  eventId: string;
  operationId: string;
  operationNumber: string;
  clientNumber: string;
  previousStatus: string;
  status: string;
  reasonCode: string | null;
  changedAt: string;
}

export interface AntifraudDecisionPayload {
  eventId: string;
  operationId: string;
  operationNumber: string;
  clientNumber: string;
  score: number;
  decision: AntifraudDecision;
  rules: RuleHit[];
  thresholds: { review: number; reject: number };
  decidedAt: string;
}

export interface NotificationMessage {
  messageId: string;
  operationId: string;
  clientId: string;
  phone: string;
  channel: 'SMS' | 'PUSH';
  kind: 'TRANSFER_COMPLETED' | 'TRANSFER_RECEIVED';
  text: string;
  createdAt: string;
}
