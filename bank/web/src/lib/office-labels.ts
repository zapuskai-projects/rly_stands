import { formatPhone } from './format';
import type { OfficeOperationRow } from './types';

export function recipientLabel(row: Pick<OfficeOperationRow, 'type' | 'recipient'>): string {
  if (row.type === 'OWN_TRANSFER') return 'Свои счета клиента';
  const who = row.recipient.displayName ?? (row.recipient.phone ? formatPhone(row.recipient.phone) : 'Получатель');
  return row.recipient.bankName && row.recipient.bankCode !== 'ZAPUSK' ? `${who}, ${row.recipient.bankName}` : who;
}

export function channelLabel(row: Pick<OfficeOperationRow, 'type' | 'route'>): string {
  if (row.type === 'OWN_TRANSFER') return 'между своими счетами';
  return row.route === 'SBP' ? 'по номеру телефона через СБП' : 'по номеру телефона';
}

export const SHORT_RULE: Record<string, string> = {
  NEW_RECIPIENT: 'новый получатель',
  NIGHT_TIME: 'ночь',
  AMOUNT_ABOVE_USUAL: 'сумма выше обычной',
  HIGH_FREQUENCY: 'много переводов за час',
};

export function reviewSummary(score: number, ruleCodes: readonly string[]): string {
  const parts = ruleCodes.map((code) => SHORT_RULE[code] ?? code);
  return `Оценка ${score}${parts.length > 0 ? ` · ${parts.join(', ')}` : ''}`;
}

export const ROLE_LABEL = { OPERATOR: 'Оператор', SENIOR: 'Старший оператор' } as const;

export const CLIENT_KIND_LABEL = { INDIVIDUAL: 'Физическое лицо', ENTREPRENEUR: 'Индивидуальный предприниматель' } as const;

export const REVIEW_STATE_LABEL = { PENDING: 'Ждёт решения', APPROVED: 'Одобрена', REJECTED: 'Отклонена', EXPIRED: 'Просрочена' } as const;

export const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  LOGIN_CODE: 'Код входа',
  TRANSFER_COMPLETED: 'Перевод выполнен',
  TRANSFER_RECEIVED: 'Поступление',
};
