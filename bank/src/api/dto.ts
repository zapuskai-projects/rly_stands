import type { Account, Card } from '../accounts/accounts.repository';
import { toApiAmount, type Kopecks } from '../accounts/money';
import type { StatementData } from '../accounts/statement';
import { toMoscowIso } from '../clock/moscow';
import type { Client } from '../clients/clients.repository';
import { describeRule } from '../antifraud/scoring';
import type { OperationRecord, StatusHistoryRecord } from '../payments/operations.repository';
import type { ReviewItem } from '../review/review.repository';
import type { Tariff } from '../tariffs/tariff';

export interface LimitUsage {
  limit: Kopecks;
  used: Kopecks;
  remaining: Kopecks;
  resetsAt: Date;
}

export interface ClientLimits {
  dailyPhoneTransfer: LimitUsage;
  monthlyFreeVolume: LimitUsage;
}

const limitUsageDto = (usage: LimitUsage) => ({
  limit: toApiAmount(usage.limit),
  used: toApiAmount(usage.used),
  remaining: toApiAmount(usage.remaining),
  resetsAt: toMoscowIso(usage.resetsAt),
});

export const tariffDto = (tariff: Tariff) => ({
  code: tariff.code,
  name: tariff.name,
  dailyPhoneTransferLimit: toApiAmount(tariff.dailyPhoneLimit),
  freeMonthlyVolume: toApiAmount(tariff.freeMonthlyVolume),
  commissionRateBps: tariff.commissionRateBps,
  commissionMin: toApiAmount(tariff.commissionMin),
  commissionMax: toApiAmount(tariff.commissionMax),
});

export const clientSummaryDto = (client: Client) => ({ id: client.id, number: client.number, fullName: client.fullName });

export const profileDto = (client: Client, tariff: Tariff, limits: ClientLimits) => ({
  id: client.id,
  number: client.number,
  fullName: client.fullName,
  phone: client.phone,
  kind: client.kind,
  resident: client.resident,
  tariff: tariffDto(tariff),
  limits: {
    dailyPhoneTransfer: limitUsageDto(limits.dailyPhoneTransfer),
    monthlyFreeVolume: limitUsageDto(limits.monthlyFreeVolume),
  },
});

const cardDto = (card: Card) => ({
  id: card.id,
  maskedNumber: `${card.number.slice(0, 6)}******${card.number.slice(12)}`,
  product: card.product,
  holderName: card.holderName,
  expiry: `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear % 100).padStart(2, '0')}`,
  status: card.status,
});

export const accountDto = (account: Account, held: Kopecks, cards: readonly Card[]) => ({
  id: account.id,
  number: account.number,
  kind: account.kind as 'CURRENT' | 'SAVINGS' | 'SETTLEMENT',
  title: account.title,
  currency: 'RUB' as const,
  status: account.status,
  isPrimary: account.isPrimary,
  balance: toApiAmount(account.balance),
  held: toApiAmount(held),
  available: toApiAmount(account.balance - held),
  openedAt: toMoscowIso(account.openedAt),
  cards: cards.map(cardDto),
});

export const statementDto = (account: Account, from: string, to: string, data: StatementData) => ({
  accountId: account.id,
  accountNumber: account.number,
  from,
  to,
  openingBalance: toApiAmount(data.openingBalance),
  closingBalance: toApiAmount(data.closingBalance),
  totalDebit: toApiAmount(data.totalDebit),
  totalCredit: toApiAmount(data.totalCredit),
  entries: data.entries.map((entry) => ({
    id: entry.id,
    postedAt: toMoscowIso(entry.postedAt),
    direction: entry.direction,
    amount: toApiAmount(entry.amount),
    description: entry.description,
    operationId: entry.operationId,
    balanceAfter: toApiAmount(entry.balanceAfter),
  })),
});

export const operationDto = (operation: OperationRecord, history: readonly StatusHistoryRecord[]) => ({
  id: operation.id,
  number: operation.number,
  type: operation.type,
  route: operation.route,
  status: operation.status,
  amount: toApiAmount(operation.amount),
  fee: toApiAmount(operation.fee),
  total: toApiAmount(operation.amount + operation.fee),
  currency: 'RUB' as const,
  fromAccount: { id: operation.fromAccountId, number: operation.fromAccountNumber },
  recipient: {
    accountNumber: operation.type === 'OWN_TRANSFER' ? operation.toAccountNumber : null,
    phone: operation.recipientPhone,
    bankCode: operation.recipientBankCode,
    bankName: operation.recipientBankName,
    displayName: operation.recipientName,
  },
  comment: operation.comment,
  rejection: operation.rejectCode ? { code: operation.rejectCode, message: operation.rejectMessage ?? '' } : null,
  createdAt: toMoscowIso(operation.createdAt),
  updatedAt: toMoscowIso(operation.updatedAt),
  completedAt: operation.completedAt ? toMoscowIso(operation.completedAt) : null,
  statusHistory: history.map((item) => ({
    status: item.status,
    at: toMoscowIso(item.changedAt),
    reasonCode: item.reasonCode,
    comment: item.comment,
  })),
});

export const reviewItemDto = (item: ReviewItem) => ({
  operationId: item.operationId,
  operationNumber: item.operationNumber,
  operationStatus: item.operationStatus,
  clientNumber: item.clientNumber,
  clientName: item.clientName,
  type: item.type,
  route: item.route,
  amount: toApiAmount(item.amount),
  recipient: { phone: item.recipientPhone, bankCode: item.recipientBankCode, bankName: item.recipientBankName, displayName: item.recipientName },
  score: item.score,
  rules: item.rules.map((rule) => ({ code: rule.code, points: rule.points, description: describeRule(rule.code) })),
  state: item.state,
  createdAt: toMoscowIso(item.createdAt),
  deadlineAt: toMoscowIso(item.deadlineAt),
  resolvedAt: item.resolvedAt ? toMoscowIso(item.resolvedAt) : null,
  resolvedBy: item.resolvedBy,
  comment: item.comment,
});
