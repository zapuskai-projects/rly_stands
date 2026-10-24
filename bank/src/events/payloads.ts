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
  type: 'OWN_TRANSFER' | 'PHONE_TRANSFER' | 'QR_PAYMENT' | 'QR_REFUND';
  route: 'INTERNAL' | 'SBP';
  amount: number;
  fee: number;
  currency: 'RUB';
  fromAccount: string;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  templateId?: string | null;
  qrId?: string | null;
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

export interface AutopaymentExecutedPayload {
  eventId: string;
  autopaymentId: string;
  runId: string;
  clientNumber: string;
  runDate: string;
  cycleDate: string;
  attempt: number;
  outcome: 'EXECUTED' | 'FAILED';
  operationId: string | null;
  operationNumber: string | null;
  reasonCode: string | null;
  amount: number;
  currency: 'RUB';
  finishedAt: string;
}

export type NotificationKind =
  | 'TRANSFER_COMPLETED'
  | 'TRANSFER_RECEIVED'
  | 'AUTOPAYMENT_REMINDER'
  | 'AUTOPAYMENT_EXECUTED'
  | 'AUTOPAYMENT_FAILED';

export interface NotificationMessage {
  messageId: string;
  operationId: string | null;
  clientId: string;
  phone: string;
  channel: 'SMS' | 'PUSH';
  kind: NotificationKind;
  text: string;
  createdAt: string;
  autopaymentId?: string;
}
