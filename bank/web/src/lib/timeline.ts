import type { Operation, StatusHistoryItem } from './types';

export type StepState = 'done' | 'current' | 'failed' | 'pending';

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  warn?: boolean;
  at: string | null;
}

const RULE_REJECTIONS = ['DAILY_LIMIT_EXCEEDED', 'ACCOUNT_ARRESTED', 'NON_RESIDENT_EXTERNAL_TRANSFER'];

const REJECTION_LABEL: Record<string, string> = {
  OPERATOR_REJECTED: 'Специалист отклонил перевод',
  REVIEW_EXPIRED: 'Срок проверки истёк, перевод отклонён',
  ANTIFRAUD_REJECTED: 'Антифрод отклонил перевод',
};

function atOf(history: readonly StatusHistoryItem[], status: string): string | null {
  return history.find((item) => item.status === status)?.at ?? null;
}

export function buildTimeline(operation: Pick<Operation, 'type' | 'route' | 'status' | 'rejection' | 'statusHistory'>): TimelineStep[] {
  const { statusHistory: history, status } = operation;
  const steps: TimelineStep[] = [{ key: 'created', label: 'Создан', state: 'done', at: atOf(history, 'CREATED') }];
  const rejectedAt = atOf(history, 'REJECTED');
  const rejectionCode = operation.rejection?.code ?? '';

  if (status === 'REJECTED' && RULE_REJECTIONS.includes(rejectionCode)) {
    steps.push({ key: 'rules', label: 'Лимиты и ограничения: перевод не прошёл проверку', state: 'failed', at: rejectedAt });
    return steps;
  }
  steps.push({ key: 'rules', label: 'Лимиты и комиссия проверены', state: 'done', at: atOf(history, 'CHECKING') });

  const reviewAt = atOf(history, 'ON_REVIEW');
  if (status === 'REJECTED') {
    if (reviewAt) steps.push({ key: 'review', label: 'Нужна проверка специалиста', state: 'done', warn: true, at: reviewAt });
    steps.push({ key: 'rejected', label: REJECTION_LABEL[rejectionCode] ?? 'Перевод отклонён', state: 'failed', at: rejectedAt });
    return steps;
  }

  if (operation.type === 'PHONE_TRANSFER') {
    if (reviewAt) {
      steps.push({
        key: 'review',
        label: status === 'ON_REVIEW' ? 'Нужна проверка специалиста' : 'Проверка специалиста пройдена',
        state: status === 'ON_REVIEW' ? 'current' : 'done',
        warn: status === 'ON_REVIEW',
        at: reviewAt,
      });
    } else {
      const passed = status !== 'CHECKING' && status !== 'CREATED';
      steps.push({ key: 'antifraud', label: passed ? 'Проверка безопасности пройдена' : 'Проверка безопасности', state: passed ? 'done' : 'current', at: passed ? atOf(history, 'PROCESSING') : null });
    }
  }

  const processingAt = atOf(history, 'PROCESSING');
  const processingLabel = operation.route === 'SBP' ? 'Отправка в банк получателя' : 'Проведение платежа';
  const finished = status === 'COMPLETED' || status === 'FAILED' || status === 'REFUNDED';
  steps.push({
    key: 'processing',
    label: processingLabel,
    state: finished ? 'done' : status === 'PROCESSING' ? 'current' : 'pending',
    at: processingAt,
  });

  if (status === 'COMPLETED') {
    steps.push({ key: 'final', label: operation.type === 'OWN_TRANSFER' ? 'Зачислено на счёт' : 'Зачислено получателю', state: 'done', at: atOf(history, 'COMPLETED') });
  } else if (status === 'FAILED') {
    const reason = history.find((item) => item.status === 'FAILED')?.reasonCode;
    steps.push({ key: 'final', label: reason === 'SBP_UNAVAILABLE' ? 'СБП недоступна, перевод не отправлен' : 'Банк получателя не принял перевод', state: 'failed', at: atOf(history, 'FAILED') });
  } else if (status === 'REFUNDED') {
    steps.push({ key: 'final', label: 'Деньги возвращены на счёт', state: 'done', warn: true, at: atOf(history, 'REFUNDED') });
  } else {
    steps.push({ key: 'final', label: operation.type === 'OWN_TRANSFER' ? 'Зачислено на счёт' : 'Зачислено получателю', state: 'pending', at: null });
  }
  return steps;
}
