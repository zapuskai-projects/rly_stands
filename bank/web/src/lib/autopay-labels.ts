import { formatPhone } from './format';
import type { Tone } from './status';
import type { Autopayment, AutopaymentStatus, RunOutcome, Template } from './types';

export const AUTOPAYMENT_STATUS_LABEL: Record<AutopaymentStatus, string> = {
  ACTIVE: 'Действует',
  PAUSED: 'На паузе',
  FAILED: 'Остановлен',
  FINISHED: 'Завершён',
};

export const AUTOPAYMENT_STATUS_TONE: Record<AutopaymentStatus, Tone> = {
  ACTIVE: 'ok',
  PAUSED: 'warn',
  FAILED: 'bad',
  FINISHED: 'neutral',
};

export const RUN_OUTCOME_LABEL: Record<RunOutcome, string> = {
  PENDING: 'Проверяется',
  EXECUTED: 'Выполнен',
  FAILED: 'Не выполнен',
};

export const RUN_OUTCOME_TONE: Record<RunOutcome, Tone> = {
  PENDING: 'info',
  EXECUTED: 'ok',
  FAILED: 'bad',
};

const FAILURE_LABEL: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'недостаточно средств на счёте',
  DAILY_LIMIT_EXCEEDED: 'превышен суточный лимит переводов',
  ACCOUNT_ARRESTED: 'на счёт наложен арест',
  NON_RESIDENT_EXTERNAL_TRANSFER: 'переводы в другие банки недоступны нерезидентам',
  ANTIFRAUD_REJECTED: 'перевод отклонён проверкой банка',
  OPERATOR_REJECTED: 'перевод отклонён специалистом банка',
  REVIEW_EXPIRED: 'истёк срок проверки перевода',
  RECIPIENT_NOT_FOUND: 'получатель не найден',
  RECIPIENT_IS_SENDER: 'получатель совпадает с отправителем',
  UNKNOWN_BANK: 'банк получателя не найден',
  ACCOUNT_NOT_FOUND: 'счёт не найден',
  SAME_ACCOUNT: 'счета списания и зачисления совпадают',
  CLIENT_BLOCKED: 'операции клиента приостановлены',
  SBP_REJECTED: 'банк получателя не принял перевод',
  SBP_UNAVAILABLE: 'система быстрых платежей недоступна',
  SBP_TIMEOUT: 'банк получателя не ответил вовремя',
  AUTOPAYMENT_CANCELLED: 'автоплатёж отменён',
  AUTOPAYMENT_PAUSED: 'автоплатёж поставлен на паузу',
  TEMPLATE_NOT_FOUND: 'шаблон удалён',
};

export function failureLabel(code: string | null): string {
  return (code ? FAILURE_LABEL[code] : undefined) ?? 'банк не смог выполнить перевод';
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function dateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

export function templateRecipient(template: Pick<Template, 'kind' | 'recipientPhone' | 'recipientBankName' | 'toAccount'>): string {
  if (template.kind === 'OWN') return 'Между своими счетами';
  const phone = template.recipientPhone ? formatPhone(template.recipientPhone) : 'Получатель';
  return template.kind === 'SBP' && template.recipientBankName ? `${phone} · ${template.recipientBankName}` : phone;
}

export function schedulePhrase(autopayment: Pick<Autopayment, 'dayOfMonth'>): string {
  return `Каждого ${autopayment.dayOfMonth}-го числа в 10:00`;
}

export function attemptNote(autopayment: Pick<Autopayment, 'status' | 'attempt' | 'failureReason'>): string | null {
  if (autopayment.attempt === 0 || !autopayment.failureReason) return null;
  const reason = failureLabel(autopayment.failureReason);
  return autopayment.status === 'FAILED'
    ? `Не удалось выполнить после ${autopayment.attempt} из 3 попыток: ${reason}`
    : `Попытка ${autopayment.attempt} из 3 не удалась: ${reason}`;
}
