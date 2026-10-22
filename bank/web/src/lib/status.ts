import type { Operation, OperationStatus } from './types';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export const STATUS_LABEL: Record<OperationStatus, string> = {
  CREATED: 'Создан',
  CHECKING: 'Проверяется',
  ON_REVIEW: 'На проверке',
  PROCESSING: 'В обработке',
  COMPLETED: 'Выполнен',
  REJECTED: 'Отклонён',
  FAILED: 'Не выполнен',
  REFUNDED: 'Деньги возвращены',
};

const STATUS_TONE: Record<OperationStatus, Tone> = {
  CREATED: 'info',
  CHECKING: 'info',
  ON_REVIEW: 'warn',
  PROCESSING: 'info',
  COMPLETED: 'ok',
  REJECTED: 'bad',
  FAILED: 'bad',
  REFUNDED: 'warn',
};

export const ACTIVE_STATUSES: readonly OperationStatus[] = ['CREATED', 'CHECKING', 'ON_REVIEW', 'PROCESSING'];

export function statusTone(status: OperationStatus): Tone {
  return STATUS_TONE[status];
}

export function isActive(status: OperationStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export const TYPE_LABEL = {
  OWN_TRANSFER: 'Между своими счетами',
  PHONE_TRANSFER: 'По номеру телефона',
} as const;

export function statusHint(operation: Pick<Operation, 'status' | 'route' | 'rejection' | 'statusHistory'>): string {
  const finalReason = [...operation.statusHistory].reverse().find((item) => item.reasonCode)?.reasonCode;
  switch (operation.status) {
    case 'CREATED':
    case 'CHECKING':
      return 'Банк проверяет перевод. Деньги заморожены на счёте и спишутся после проведения.';
    case 'ON_REVIEW':
      return 'Перевод проверяет специалист банка, обычно до 30 минут. Деньги заморожены на счёте и вернутся, если перевод отклонят.';
    case 'PROCESSING':
      return operation.route === 'SBP' ? 'Перевод отправлен в банк получателя, ждём ответа.' : 'Перевод проводится.';
    case 'COMPLETED':
      return 'Деньги зачислены получателю.';
    case 'REJECTED':
      return operation.rejection ? `${operation.rejection.message}. Деньги остались на вашем счёте.` : 'Перевод отклонён. Деньги остались на вашем счёте.';
    case 'FAILED':
      return finalReason === 'SBP_UNAVAILABLE'
        ? 'Система быстрых платежей недоступна, перевод не отправлен. Деньги остались на вашем счёте.'
        : 'Банк получателя не принял перевод. Деньги остались на вашем счёте.';
    case 'REFUNDED':
      return 'Банк получателя не ответил вовремя. Списанные деньги возвращены на ваш счёт.';
  }
}
