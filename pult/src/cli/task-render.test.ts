import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CheckOutcome, SessionTask } from '../platform/types';
import { stripAnsi } from '../util/out';
import { findTask, renderCondition, renderOutcome, renderTaskRows } from './task-render';

function task(id: string, title: string, overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id,
    title,
    modules: [{ key: 'kit-rabbitmq', title: 'RabbitMQ' }],
    status: 'NOT_STARTED',
    attemptId: null,
    label: null,
    needsUpdate: false,
    missingPrimitives: [],
    verifiedOnStand: null,
    verifiedFailureOnStand: null,
    ...overrides,
  };
}

const outcome = (overrides: Partial<CheckOutcome['result']> = {}): CheckOutcome => ({
  attemptId: 'a1',
  status: 'FAILED',
  result: {
    passed: false,
    unavailable: false,
    message: 'Не зачтено: 3 из 4',
    detail: null,
    summary: { passed: 3, total: 4 },
    assertionResults: [
      { id: 'a1', title: 'Обменник k7f3qa.docs типа topic', passed: true, unavailable: false, hint: null, detail: null },
      { id: 'a2', title: 'Отклонённый документ попал в dead-letter', passed: false, unavailable: false, hint: 'у очереди нет аргумента x-dead-letter-exchange', detail: null },
    ],
    ...overrides,
  },
});

describe('renderOutcome', () => {
  it('печатает пункты, подсказку к невыполненному и итог', () => {
    const text = renderOutcome('Очередь согласования', outcome()).map(stripAnsi);
    assert.deepEqual(text, [
      'Очередь согласования',
      '✓ Обменник k7f3qa.docs типа topic',
      '✗ Отклонённый документ попал в dead-letter',
      '  Подсказка: у очереди нет аргумента x-dead-letter-exchange',
      '',
      'Итог: не зачтено, 3 из 4. Исправьте и запустите проверку снова.',
    ]);
  });

  it('зачёт и «проверка не состоялась» различаются', () => {
    const passed = renderOutcome('Т', outcome({ passed: true, summary: { passed: 4, total: 4 }, assertionResults: [] })).map(stripAnsi);
    assert.equal(passed.at(-1), 'Итог: зачтено, 4 из 4.');
    const broken = renderOutcome(
      'Т',
      outcome({ unavailable: true, message: 'Проверка не состоялась: пульт не смог собрать факты', detail: 'RabbitMQ не отвечает', assertionResults: [{ id: 'a1', title: 'Обменник', passed: false, unavailable: true, hint: null, detail: 'RabbitMQ не отвечает' }] }),
    ).map(stripAnsi);
    assert.ok(broken.includes('? Обменник'));
    assert.ok(broken.some((row) => row.includes('Проверка не состоялась')));
    assert.ok(!broken.some((row) => row.includes('не зачтено')));
  });

  it('сбой проверки моделью не отправляет проверять стенды', () => {
    const text = renderOutcome(
      'Т',
      outcome({ unavailable: true, reviewUnavailable: true, message: 'Не удалось посмотреть работу', detail: 'тайм-аут' }),
    ).map(stripAnsi);
    assert.ok(text.includes('Не удалось посмотреть работу'));
    assert.equal(text.at(-1), 'Решение собрано, не ответила проверка на платформе. Запустите ./stand check ещё раз.');
  });
});

describe('список задач', () => {
  const tasks = [task('lab-aaa', 'Очередь согласования'), task('lab-bbb', 'Процесс договора', { status: 'FAILED' }), task('lab-ccc', 'Старая', { needsUpdate: true })];

  it('строки со статусами и номером', () => {
    const rows = renderTaskRows(tasks, 1).map(stripAnsi);
    assert.match(rows[0] ?? '', /1\s+Очередь согласования\s+RabbitMQ\s+не начата/);
    assert.match(rows[1] ?? '', /▸ 2\s+Процесс договора\s+RabbitMQ\s+не зачтена/);
    assert.match(rows[2] ?? '', /обновите набор/);
  });

  it('выбор по номеру, идентификатору и однозначной части названия', () => {
    assert.equal(findTask(tasks, '2')?.id, 'lab-bbb');
    assert.equal(findTask(tasks, 'lab-ccc')?.id, 'lab-ccc');
    assert.equal(findTask(tasks, 'договора')?.id, 'lab-bbb');
    assert.equal(findTask(tasks, 'а'), undefined);
    assert.equal(findTask(tasks, '9'), undefined);
  });
});

describe('renderCondition', () => {
  it('убирает разметку жирного и сохраняет остальные строки', () => {
    const rows = renderCondition('**Что сделать:** настроить маршрут\n\n1. Создайте обменник `abc123.docs`').map(stripAnsi);
    assert.deepEqual(rows, ['Что сделать: настроить маршрут', '', '1. Создайте обменник `abc123.docs`']);
  });
});

describe('тикеты учебного проекта', () => {
  const project = (code: string, state: 'DONE' | 'OPEN' | 'LOCKED', unlocksAfter: string | null = null) => ({
    key: 'zapusk-bank',
    title: 'ЗапускБанк',
    memberId: 'm1',
    trackTitle: 'Аналитик',
    code,
    release: 'r1',
    state,
    current: state === 'OPEN',
    unlocksAfter,
  });
  const tickets = [
    task('l0', 'Поднять банк', { project: project('ZB-100', 'DONE'), status: 'PASSED' }),
    task('l1', 'Перевод между счетами', { project: project('ZB-101', 'OPEN') }),
    task('l2', 'Лимиты', { project: project('ZB-102', 'LOCKED', 'ZB-101') }),
  ];

  it('идут группой проекта и роли, с кодом и «после ZB-…» у закрытых', () => {
    const rows = renderTaskRows(tickets, null).map(stripAnsi);
    assert.equal(rows[0]?.trim(), 'ЗапускБанк · Аналитик');
    assert.match(rows[1] ?? '', /1 +ZB-100 Поднять банк .*зачтена/);
    assert.match(rows[2] ?? '', /2 +ZB-101 Перевод между счетами .*не начата/);
    assert.match(rows[3] ?? '', /3 +ZB-102 Лимиты .*после ZB-101/);
  });

  it('находятся по коду тикета', () => {
    assert.equal(findTask(tickets, 'zb-101')?.id, 'l1');
  });
});
