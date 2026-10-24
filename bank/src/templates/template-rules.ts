import type { Kopecks } from '../accounts/money';
import type { OperationType } from '../payments/operations.repository';
import type { TransferCommand } from '../payments/transfer-command';
import { BANK } from '../shared/bank-identity';

export const MAX_TEMPLATES_PER_CLIENT = 20;
export const TEMPLATE_NAME_MAX = 40;

export type TemplateKind = 'PHONE' | 'OWN' | 'SBP';

export interface TemplateRecord {
  id: string;
  clientId: string;
  name: string;
  kind: TemplateKind;
  fromAccountId: string;
  fromAccountNumber: string;
  toAccountId: string | null;
  toAccountNumber: string | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  amount: Kopecks | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function normalizeTemplateName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function templateNameIssue(name: string): string | null {
  if (name.length === 0) return 'Название не может быть пустым';
  if (name.length > TEMPLATE_NAME_MAX) return `Название длиннее ${TEMPLATE_NAME_MAX} символов`;
  return null;
}

export function kindOfOperation(operation: { type: OperationType; route: 'INTERNAL' | 'SBP' }): TemplateKind {
  if (operation.type === 'OWN_TRANSFER') return 'OWN';
  return operation.route === 'SBP' ? 'SBP' : 'PHONE';
}

export function resolveAmount(templateAmount: Kopecks | null, requested: Kopecks | null | undefined): Kopecks | null {
  return requested ?? templateAmount;
}

export function templateCommand(template: TemplateRecord, amount: Kopecks, comment: string | null): TransferCommand {
  if (template.kind === 'OWN') {
    return {
      type: 'OWN_TRANSFER',
      fromAccount: template.fromAccountNumber,
      toAccount: template.toAccountNumber as string,
      amount,
      comment,
    };
  }
  return {
    type: 'PHONE_TRANSFER',
    fromAccount: template.fromAccountNumber,
    recipientPhone: template.recipientPhone as string,
    recipientBankCode: template.recipientBankCode ?? BANK.code,
    amount,
    comment,
  };
}
