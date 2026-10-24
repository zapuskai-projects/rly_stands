import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { AutopaymentRecord, RunRecord } from '../autopayments/autopayments.repository';
import type { TemplateRecord } from '../templates/template-rules';

export const templateDto = (template: TemplateRecord) => ({
  id: template.id,
  name: template.name,
  kind: template.kind,
  fromAccount: template.fromAccountNumber,
  toAccount: template.toAccountNumber,
  recipientPhone: template.recipientPhone,
  recipientBankCode: template.recipientBankCode,
  recipientBankName: template.recipientBankName,
  amount: template.amount === null ? null : toApiAmount(template.amount),
  comment: template.comment,
  createdAt: toMoscowIso(template.createdAt),
  updatedAt: toMoscowIso(template.updatedAt),
});

export const autopaymentDto = (autopayment: AutopaymentRecord) => ({
  id: autopayment.id,
  templateId: autopayment.templateId,
  templateName: autopayment.templateName,
  status: autopayment.status,
  dayOfMonth: autopayment.dayOfMonth,
  amount: toApiAmount(autopayment.amount),
  endsOn: autopayment.endsOn,
  nextRunOn: autopayment.nextRunOn,
  attempt: autopayment.attempt,
  failureReason: autopayment.failureCode,
  createdAt: toMoscowIso(autopayment.createdAt),
  updatedAt: toMoscowIso(autopayment.updatedAt),
});

export const runDto = (run: RunRecord) => ({
  id: run.id,
  autopaymentId: run.autopaymentId,
  runDate: run.runDate,
  cycleDate: run.cycleDate,
  attempt: run.attempt,
  outcome: run.outcome,
  operationId: run.operationId,
  operationNumber: run.operationNumber,
  reasonCode: run.reasonCode,
  amount: toApiAmount(run.amount),
  startedAt: toMoscowIso(run.startedAt),
  finishedAt: run.finishedAt ? toMoscowIso(run.finishedAt) : null,
});
