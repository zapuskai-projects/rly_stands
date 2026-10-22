import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTransition, isTerminal, LIMIT_COUNTED_STATUSES, OPERATION_STATUSES, type OperationStatus } from './status';

describe('статусная модель платежа', () => {
  it('основной путь: создан → проверка → обработка → исполнен', () => {
    const path: OperationStatus[] = ['CREATED', 'CHECKING', 'PROCESSING', 'COMPLETED'];
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.equal(canTransition(path[i] as OperationStatus, path[i + 1] as OperationStatus), true);
    }
  });

  it('путь через ручную проверку', () => {
    assert.equal(canTransition('CHECKING', 'ON_REVIEW'), true);
    assert.equal(canTransition('ON_REVIEW', 'PROCESSING'), true);
    assert.equal(canTransition('ON_REVIEW', 'REJECTED'), true);
  });

  it('отказ возможен на проверке и после неё, но не после обработки', () => {
    assert.equal(canTransition('CHECKING', 'REJECTED'), true);
    assert.equal(canTransition('PROCESSING', 'REJECTED'), false);
  });

  it('отказ СБП и возврат начинаются из обработки', () => {
    assert.equal(canTransition('PROCESSING', 'FAILED'), true);
    assert.equal(canTransition('PROCESSING', 'REFUNDED'), true);
    assert.equal(canTransition('CHECKING', 'FAILED'), false);
  });

  it('пропускать шаги нельзя', () => {
    assert.equal(canTransition('CREATED', 'PROCESSING'), false);
    assert.equal(canTransition('CREATED', 'COMPLETED'), false);
    assert.equal(canTransition('CHECKING', 'COMPLETED'), false);
  });

  it('конечные статусы никуда не ведут', () => {
    for (const status of ['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED'] as const) {
      assert.equal(isTerminal(status), true);
      for (const target of OPERATION_STATUSES) assert.equal(canTransition(status, target), false);
    }
    for (const status of ['CREATED', 'CHECKING', 'ON_REVIEW', 'PROCESSING'] as const) {
      assert.equal(isTerminal(status), false);
    }
  });

  it('в лимит входят незавершённые и исполненные, отказанные и возвращённые — нет', () => {
    assert.deepEqual([...LIMIT_COUNTED_STATUSES].sort(), ['CHECKING', 'COMPLETED', 'CREATED', 'ON_REVIEW', 'PROCESSING']);
  });
});
