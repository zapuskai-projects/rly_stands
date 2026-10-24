import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusHint, statusTone } from './status';
import { buildTimeline } from './timeline';
import type { Operation, OperationStatus } from './types';

type Input = Pick<Operation, 'type' | 'route' | 'status' | 'rejection' | 'statusHistory'>;

function operation(statuses: [OperationStatus, string?][], overrides: Partial<Input> = {}): Input {
  const statusHistory = statuses.map(([status, reasonCode], index) => ({
    status,
    at: `2026-10-20T23:40:${String(10 + index).padStart(2, '0')}.000+03:00`,
    reasonCode: reasonCode ?? null,
    comment: null,
  }));
  return { type: 'PHONE_TRANSFER', route: 'INTERNAL', rejection: null, statusHistory, status: statuses.at(-1)?.[0] as OperationStatus, ...overrides };
}

const summary = (input: Input) => buildTimeline(input).map((step) => `${step.key}:${step.state}`);

describe('ход операции', () => {
  it('выполненный перевод по телефону: все шаги пройдены', () => {
    const steps = buildTimeline(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']]));
    assert.deepEqual(steps.map((step) => [step.key, step.state]), [
      ['created', 'done'],
      ['rules', 'done'],
      ['antifraud', 'done'],
      ['processing', 'done'],
      ['final', 'done'],
    ]);
    assert.equal(steps.at(-1)?.label, 'Зачислено получателю');
    assert.equal(steps.at(-1)?.at, '2026-10-20T23:40:13.000+03:00');
  });

  it('на проверке специалиста: текущий шаг с предупреждением, дальше ждут', () => {
    const steps = buildTimeline(operation([['CREATED'], ['CHECKING'], ['ON_REVIEW', 'ANTIFRAUD_REVIEW']], { route: 'SBP' }));
    assert.deepEqual(steps.map((step) => [step.key, step.state]), [
      ['created', 'done'],
      ['rules', 'done'],
      ['review', 'current'],
      ['processing', 'pending'],
      ['final', 'pending'],
    ]);
    assert.equal(steps[2]?.warn, true);
    assert.equal(steps[3]?.label, 'Отправка в банк получателя');
  });

  it('после одобрения проверка специалиста отмечена пройденной', () => {
    const steps = buildTimeline(operation([['CREATED'], ['CHECKING'], ['ON_REVIEW'], ['PROCESSING'], ['COMPLETED']]));
    assert.equal(steps.find((step) => step.key === 'review')?.label, 'Проверка специалиста пройдена');
    assert.equal(steps.find((step) => step.key === 'review')?.state, 'done');
  });

  it('пока антифрод думает, шаг проверки безопасности текущий', () => {
    assert.deepEqual(summary(operation([['CREATED'], ['CHECKING']])), ['created:done', 'rules:done', 'antifraud:current', 'processing:pending', 'final:pending']);
  });

  it('отказ по лимиту обрывает ход на проверке лимитов', () => {
    const steps = buildTimeline(operation([['CREATED'], ['CHECKING'], ['REJECTED', 'DAILY_LIMIT_EXCEEDED']], { rejection: { code: 'DAILY_LIMIT_EXCEEDED', message: 'Превышен лимит' } }));
    assert.deepEqual(steps.map((step) => [step.key, step.state]), [['created', 'done'], ['rules', 'failed']]);
  });

  it('отказ оператора и просрочка называются по причине', () => {
    const base = [['CREATED'], ['CHECKING'], ['ON_REVIEW'], ['REJECTED']] as [OperationStatus, string?][];
    const byOperator = buildTimeline(operation(base, { rejection: { code: 'OPERATOR_REJECTED', message: 'x' } }));
    assert.equal(byOperator.at(-1)?.label, 'Специалист отклонил перевод');
    assert.equal(byOperator.at(-1)?.state, 'failed');
    const expired = buildTimeline(operation(base, { rejection: { code: 'REVIEW_EXPIRED', message: 'x' } }));
    assert.equal(expired.at(-1)?.label, 'Срок проверки истёк, перевод отклонён');
  });

  it('отказ СБП, недоступность и возврат различаются', () => {
    const failed = buildTimeline(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['FAILED', 'SBP_REJECTED']], { route: 'SBP' }));
    assert.equal(failed.at(-1)?.label, 'Банк получателя не принял перевод');
    const down = buildTimeline(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['FAILED', 'SBP_UNAVAILABLE']], { route: 'SBP' }));
    assert.equal(down.at(-1)?.label, 'СБП недоступна, перевод не отправлен');
    const refunded = buildTimeline(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['REFUNDED', 'SBP_TIMEOUT']], { route: 'SBP' }));
    assert.deepEqual([refunded.at(-1)?.label, refunded.at(-1)?.state, refunded.at(-1)?.warn], ['Деньги возвращены на счёт', 'done', true]);
  });

  it('перевод между своими счетами идёт без проверки безопасности', () => {
    const steps = buildTimeline(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']], { type: 'OWN_TRANSFER' }));
    assert.deepEqual(steps.map((step) => step.key), ['created', 'rules', 'processing', 'final']);
    assert.equal(steps.at(-1)?.label, 'Зачислено на счёт');
  });
});

describe('статус для человека', () => {
  it('цвета по смыслу: выполнено, внимание, отказ, в процессе', () => {
    assert.equal(statusTone('COMPLETED'), 'ok');
    assert.equal(statusTone('ON_REVIEW'), 'warn');
    assert.equal(statusTone('REFUNDED'), 'warn');
    assert.equal(statusTone('REJECTED'), 'bad');
    assert.equal(statusTone('FAILED'), 'bad');
    assert.equal(statusTone('PROCESSING'), 'info');
  });

  it('пояснение под статусом называет судьбу денег', () => {
    assert.match(statusHint(operation([['CREATED'], ['CHECKING'], ['ON_REVIEW']])), /до 30 минут.*заморожены/);
    assert.match(statusHint(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['REFUNDED']], { route: 'SBP' })), /возвращены на ваш счёт/);
    assert.match(statusHint(operation([['CREATED'], ['CHECKING'], ['REJECTED']], { rejection: { code: 'DAILY_LIMIT_EXCEEDED', message: 'Превышен суточный лимит' } })), /Превышен суточный лимит\. Деньги остались/);
    assert.match(statusHint(operation([['CREATED'], ['CHECKING'], ['PROCESSING'], ['FAILED', 'SBP_UNAVAILABLE']], { route: 'SBP' })), /недоступна/);
  });
});

describe('ход оплаты по QR', () => {
  const qr = (statuses: [OperationStatus, string?][], overrides: Partial<Input> = {}) => operation(statuses, { type: 'QR_PAYMENT', ...overrides });

  it('выполненная оплата: проверка безопасности и зачисление магазину', () => {
    const steps = buildTimeline(qr([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']]));
    assert.deepEqual(steps.map((step) => [step.key, step.state]), [
      ['created', 'done'],
      ['rules', 'done'],
      ['antifraud', 'done'],
      ['processing', 'done'],
      ['final', 'done'],
    ]);
    assert.equal(steps[1]?.label, 'Ограничения по счёту проверены');
    assert.equal(steps.at(-1)?.label, 'Зачислено магазину');
  });

  it('оплата на проверке специалиста ждёт, конец называет магазин', () => {
    const steps = buildTimeline(qr([['CREATED'], ['CHECKING'], ['ON_REVIEW', 'ANTIFRAUD_REVIEW']]));
    assert.equal(steps.find((step) => step.key === 'review')?.state, 'current');
    assert.equal(steps.at(-1)?.label, 'Зачислено магазину');
  });

  it('отклонённая оплата называет оплату, а не перевод', () => {
    const rejection = { code: 'OPERATOR_REJECTED', message: 'Нет' };
    const steps = buildTimeline(qr([['CREATED'], ['CHECKING'], ['ON_REVIEW'], ['REJECTED', 'OPERATOR_REJECTED']], { rejection }));
    assert.equal(steps.at(-1)?.label, 'Специалист отклонил оплату');
    const arrest = buildTimeline(qr([['CREATED'], ['CHECKING'], ['REJECTED', 'ACCOUNT_ARRESTED']], { rejection: { code: 'ACCOUNT_ARRESTED', message: 'Арест' } }));
    assert.equal(arrest.at(-1)?.label, 'Ограничения по счёту: оплата не прошла проверку');
  });

  it('возврат по QR: без проверки безопасности, конец называет покупателя', () => {
    const steps = buildTimeline(qr([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']], { type: 'QR_REFUND' }));
    assert.deepEqual(steps.map((step) => step.key), ['created', 'rules', 'processing', 'final']);
    assert.equal(steps.at(-1)?.label, 'Возвращено покупателю');
    assert.match(statusHint(qr([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']], { type: 'QR_REFUND' })), /возвращены покупателю/);
  });

  it('пояснение под статусом говорит про оплату и магазин', () => {
    assert.match(statusHint(qr([['CREATED'], ['CHECKING']])), /проверяет оплату/);
    assert.match(statusHint(qr([['CREATED'], ['CHECKING'], ['PROCESSING'], ['COMPLETED']])), /магазин/);
    assert.match(statusHint(qr([['CREATED'], ['CHECKING'], ['REJECTED']], { rejection: { code: 'ACCOUNT_ARRESTED', message: 'Арест' } })), /Деньги остались на вашем счёте/);
  });
});
