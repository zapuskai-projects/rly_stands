export type OperationStatus = 'CREATED' | 'CHECKING' | 'ON_REVIEW' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'REFUNDED';
export type OperationType = 'OWN_TRANSFER' | 'PHONE_TRANSFER';
export type OperationRoute = 'INTERNAL' | 'SBP';

export interface StatusHistoryItem {
  status: OperationStatus;
  at: string;
  reasonCode: string | null;
  comment: string | null;
}

export interface Operation {
  id: string;
  number: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  amount: number;
  fee: number;
  total: number;
  currency: 'RUB';
  fromAccount: { id: string; number: string };
  recipient: { accountNumber: string | null; phone: string | null; bankCode: string | null; bankName: string | null; displayName: string | null };
  comment: string | null;
  templateId?: string | null;
  rejection: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  statusHistory: StatusHistoryItem[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Card {
  id: string;
  maskedNumber: string;
  product: string;
  holderName: string;
  expiry: string;
  status: 'ACTIVE' | 'BLOCKED';
}

export interface Account {
  id: string;
  number: string;
  kind: 'CURRENT' | 'SAVINGS' | 'SETTLEMENT';
  title: string;
  currency: 'RUB';
  status: 'ACTIVE' | 'ARRESTED' | 'CLOSED';
  isPrimary: boolean;
  balance: number;
  held: number;
  available: number;
  openedAt: string;
  cards: Card[];
}

export interface LimitUsage {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}

export interface Tariff {
  code: string;
  name: string;
  dailyPhoneTransferLimit: number;
  freeMonthlyVolume: number;
  commissionRateBps: number;
  commissionMin: number;
  commissionMax: number;
}

export interface Profile {
  id: string;
  number: string;
  fullName: string;
  phone: string;
  kind: 'INDIVIDUAL' | 'ENTREPRENEUR';
  resident: boolean;
  tariff: Tariff;
  limits: { dailyPhoneTransfer: LimitUsage; monthlyFreeVolume: LimitUsage };
}

export interface StatementEntry {
  id: number;
  postedAt: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
  description: string;
  operationId: string | null;
  balanceAfter: number;
}

export interface Statement {
  accountId: string;
  accountNumber: string;
  from: string;
  to: string;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  entries: StatementEntry[];
}

export interface Bank {
  code: string;
  name: string;
}

export interface RecipientLookup {
  phone: string;
  bankCode: string;
  bankName: string;
  displayName: string | null;
  known: boolean;
}

export interface SmsMessage {
  id: number;
  phone: string;
  channel: 'SMS' | 'PUSH';
  kind: string;
  text: string;
  createdAt: string;
}

export interface AntifraudRule {
  code: string;
  points: number;
  description: string;
}

export interface ReviewItem {
  operationId: string;
  operationNumber: string;
  operationStatus: OperationStatus;
  clientNumber: string;
  clientName: string;
  type: OperationType;
  route: OperationRoute;
  amount: number;
  recipient: { phone: string | null; bankCode: string | null; bankName: string | null; displayName: string | null };
  score: number;
  rules: AntifraudRule[];
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: string;
  deadlineAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  comment: string | null;
}

export interface OfficeOperationRow {
  id: string;
  number: string;
  clientNumber: string;
  clientName: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  amount: number;
  fee: number;
  recipient: { phone: string | null; bankCode: string | null; bankName: string | null; displayName: string | null };
  createdAt: string;
}

export interface ReviewDetails {
  review: ReviewItem;
  client: {
    number: string;
    fullName: string;
    kind: 'INDIVIDUAL' | 'ENTREPRENEUR';
    resident: boolean;
    customerSince: string;
    tariffName: string;
    usualAmount: number | null;
    accountNumber: string;
  };
  thresholds: { review: number; reject: number };
  recentOperations: OfficeOperationRow[];
}

export interface Operator {
  id: string;
  login: string;
  fullName: string;
  shortName: string;
  role: 'OPERATOR' | 'SENIOR';
}

export interface OfficeClient {
  id: string;
  number: string;
  fullName: string;
  phone: string;
  kind: 'INDIVIDUAL' | 'ENTREPRENEUR';
  resident: boolean;
  inn: string | null;
  status: 'ACTIVE' | 'BLOCKED';
  tariff: { code: string; name: string };
  customerSince: string;
  accountsCount: number;
  totalBalance: number;
}

export interface OfficeClientDetails {
  client: OfficeClient;
  accounts: { id: string; number: string; kind: string; title: string; status: string; balance: number; held: number; available: number }[];
  tariff: Tariff;
  limits: { dailyPhoneTransfer: LimitUsage; monthlyFreeVolume: LimitUsage };
  dailyLimitOverride: number | null;
  recentOperations: OfficeOperationRow[];
}

export interface OfficeOperation {
  operation: Operation;
  client: { number: string; fullName: string };
  antifraud: { score: number; decision: 'APPROVE' | 'REVIEW' | 'REJECT'; rules: AntifraudRule[]; thresholds: { review: number; reject: number }; decidedAt: string } | null;
  review: ReviewItem | null;
}

export interface OfficeNotification {
  id: number;
  phone: string;
  clientName: string | null;
  channel: 'SMS' | 'PUSH';
  kind: string;
  text: string;
  operationNumber: string | null;
  createdAt: string;
}

export interface DocumentMeta {
  slug: string;
  title: string;
  version: string;
  updated: string;
}

export interface DocumentIndex {
  documents: DocumentMeta[];
  specs: { id: string; title: string; version: string; href: string; rawHref: string }[];
}

export interface BankDocument extends DocumentMeta {
  markdown: string;
}

export type TemplateKind = 'PHONE' | 'OWN' | 'SBP';

export interface Template {
  id: string;
  name: string;
  kind: TemplateKind;
  fromAccount: string;
  toAccount: string | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  amount: number | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AutopaymentStatus = 'ACTIVE' | 'PAUSED' | 'FAILED' | 'FINISHED';
export type RunOutcome = 'PENDING' | 'EXECUTED' | 'FAILED';

export interface Autopayment {
  id: string;
  templateId: string;
  templateName: string;
  status: AutopaymentStatus;
  dayOfMonth: number;
  amount: number;
  endsOn: string | null;
  nextRunOn: string | null;
  attempt: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutopaymentRun {
  id: string;
  autopaymentId: string;
  runDate: string;
  cycleDate: string;
  attempt: number;
  outcome: RunOutcome;
  operationId: string | null;
  operationNumber: string | null;
  reasonCode: string | null;
  amount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface OfficeAutopayment {
  autopayment: Autopayment;
  runs: AutopaymentRun[];
}
