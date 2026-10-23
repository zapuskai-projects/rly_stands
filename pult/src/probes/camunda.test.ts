import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { waitingFor } from './camunda';

describe('кого ждёт процесс', () => {
  it('группы кандидатов и исполнители открытых задач без повторов, по алфавиту', () => {
    assert.deepEqual(
      waitingFor([
        { id: 'seniorReview', name: 'Проверка старшим', assignee: null, candidateGroups: ['senior'] },
        { id: 'extra', name: 'Дополнительно', assignee: 'demo', candidateGroups: ['operator', 'senior'] },
      ]),
      ['demo', 'operator', 'senior'],
    );
  });

  it('нет открытых задач — никого не ждёт', () => {
    assert.deepEqual(waitingFor([]), []);
  });
});
