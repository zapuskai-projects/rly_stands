import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { StoredDecision } from '../antifraud/decisions.repository';
import { describeRule } from '../antifraud/scoring';
import type { Operator } from '../operators/operators.repository';
import type { OfficeClientRow } from '../office/clients.repository';
import type { OfficeNotificationRow } from '../office/notifications.repository';
import type { OfficeOperationRow } from '../office/operations.repository';

export const operatorDto = (operator: Operator) => ({
  id: operator.id,
  login: operator.login,
  fullName: operator.fullName,
  shortName: operator.shortName,
  role: operator.role,
});

export const officeOperationRowDto = (row: OfficeOperationRow) => ({
  id: row.id,
  number: row.number,
  clientNumber: row.clientNumber,
  clientName: row.clientName,
  type: row.type,
  route: row.route,
  status: row.status,
  amount: toApiAmount(row.amount),
  fee: toApiAmount(row.fee),
  recipient: {
    phone: row.recipientPhone,
    bankCode: row.recipientBankCode,
    bankName: row.recipientBankName,
    displayName: row.recipientName,
  },
  createdAt: toMoscowIso(row.createdAt),
});

export const officeClientDto = (row: OfficeClientRow) => ({
  id: row.id,
  number: row.number,
  fullName: row.fullName,
  phone: row.phone,
  kind: row.kind,
  resident: row.resident,
  inn: row.inn,
  status: row.status,
  tariff: { code: row.tariffCode, name: row.tariffName },
  customerSince: toMoscowIso(row.customerSince),
  accountsCount: row.accountsCount,
  totalBalance: toApiAmount(row.totalBalance),
});

export const antifraudResultDto = (decision: StoredDecision) => ({
  score: decision.score,
  decision: decision.decision,
  rules: decision.rules.map((rule) => ({ code: rule.code, points: rule.points, description: describeRule(rule.code) })),
  thresholds: { review: decision.reviewThreshold, reject: decision.rejectThreshold },
  decidedAt: toMoscowIso(decision.decidedAt),
});

export const officeNotificationDto = (row: OfficeNotificationRow) => ({
  id: row.id,
  phone: row.phone,
  clientName: row.clientName,
  channel: row.channel,
  kind: row.kind,
  text: row.text,
  operationNumber: row.operationNumber,
  createdAt: toMoscowIso(row.createdAt),
});
