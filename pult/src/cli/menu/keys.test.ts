import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keyAction } from './keys';

describe('keyAction', () => {
  it('Ctrl+C прерывает, другие сочетания с Ctrl ничего не делают', () => {
    assert.equal(keyAction({ ctrl: true, name: 'c' }), 'interrupt');
    assert.equal(keyAction({ ctrl: true, name: 'p', sequence: '\u0010' }), null);
    assert.equal(keyAction({ ctrl: true, name: 'q' }), null);
  });

  it('«Задачи» открываются латинской t и русской «з» в обоих регистрах', () => {
    assert.equal(keyAction({ name: 't', sequence: 't' }), 'tasks');
    assert.equal(keyAction({ name: 'z', sequence: 'з' }), 'tasks');
    assert.equal(keyAction({ sequence: 'З' }), 'tasks');
  });

  it('«Проверить» — латинская p и русская «п» в обоих регистрах', () => {
    assert.equal(keyAction({ name: 'p', sequence: 'p' }), 'check');
    assert.equal(keyAction({ sequence: 'п' }), 'check');
    assert.equal(keyAction({ sequence: 'П' }), 'check');
  });

  it('выход: Esc, q и русская «в»', () => {
    assert.equal(keyAction({ name: 'escape' }), 'back');
    assert.equal(keyAction({ name: 'q', sequence: 'q' }), 'back');
    assert.equal(keyAction({ sequence: 'в' }), 'back');
    assert.equal(keyAction({ sequence: 'В' }), 'back');
  });

  it('стрелки и Enter', () => {
    assert.equal(keyAction({ name: 'up' }), 'up');
    assert.equal(keyAction({ name: 'down' }), 'down');
    assert.equal(keyAction({ name: 'return' }), 'enter');
  });

  it('остальные клавиши игнорируются, пустое событие тоже', () => {
    assert.equal(keyAction({ name: 'x', sequence: 'x' }), null);
    assert.equal(keyAction({ sequence: 'ы' }), null);
    assert.equal(keyAction({}), null);
  });
});
