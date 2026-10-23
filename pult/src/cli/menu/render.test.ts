import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripAnsi } from '../../util/out';
import { renderMenu, type MenuView } from './render';

const view: MenuView = {
  version: '0.1.0',
  userName: 'Юлия Ляшенко',
  tokenUntil: '30.10',
  selected: 0,
  reminder: null,
  notices: [],
  message: null,
  stale: false,
  rows: [
    { key: 'kit-rabbitmq', title: 'RabbitMQ', profile: 'rabbitmq', state: 'running', note: 'панель: http://localhost:15672' },
    { key: 'kit-kafka', title: 'Kafka', profile: 'kafka', state: 'stopped', note: '' },
    { key: 'kit-elasticsearch', title: 'Elasticsearch', profile: 'elasticsearch', state: 'unavailable', note: 'не назначен' },
  ],
};

describe('renderMenu', () => {
  const text = renderMenu(view).map(stripAnsi);

  it('шапка с версией и сроком токена', () => {
    assert.match(text[0] ?? '', /Запускай · стенды\s+пульт 0\.1\.0/);
    assert.equal(text[1], ' Юлия Ляшенко · токен действует до 30.10');
  });

  it('строки стендов с отметкой выбора, состоянием и пояснением', () => {
    const rows = text.filter((row) => /RabbitMQ|Kafka|Elasticsearch/.test(row));
    assert.match(rows[0] ?? '', /^ ▸ ● RabbitMQ\s+работает\s+панель: http:\/\/localhost:15672$/);
    assert.match(rows[1] ?? '', /^   ○ Kafka\s+остановлен$/);
    assert.match(rows[2] ?? '', /^   ✕ Elasticsearch\s+недоступен\s+не назначен$/);
  });

  it('подсказка по клавишам в последней строке', () => {
    assert.equal(text.at(-1), ' ↑↓ выбрать · Enter запустить/остановить · Р перезапустить · О остановить все · З задачи · П проверить · В выйти');
  });

  it('экран задач показывает их список и свою подсказку', () => {
    const tasksView = renderMenu({
      ...view,
      mode: 'tasks',
      currentTask: 'Очередь согласования',
      tasks: [
        {
          id: 'lab1',
          title: 'Очередь согласования',
          modules: [{ key: 'kit-rabbitmq', title: 'RabbitMQ' }],
          status: 'FAILED',
          attemptId: 'a1',
          label: 'k7f3qa',
          needsUpdate: false,
          missingPrimitives: [],
          verifiedOnStand: null,
          verifiedFailureOnStand: null,
        },
      ],
    }).map(stripAnsi);
    assert.ok(tasksView.some((row) => row.includes('Текущая задача: Очередь согласования')));
    assert.ok(tasksView.some((row) => /1\s+Очередь согласования\s+RabbitMQ\s+не зачтена/.test(row)));
    assert.equal(tasksView.at(-1), ' ↑↓ выбрать · Enter начать задачу · П проверить · Esc назад');
  });

  it('напоминание об обновлении и пометки агента выводятся над таблицей', () => {
    const extended = renderMenu({
      ...view,
      reminder: 'Вышла версия 0.2.0. Обновите набор: git pull',
      notices: ['Kafka: выключен на платформе'],
    }).map(stripAnsi);
    assert.ok(extended.includes(' Вышла версия 0.2.0. Обновите набор: git pull'));
    assert.ok(extended.includes(' ! Kafka: выключен на платформе'));
  });
});
