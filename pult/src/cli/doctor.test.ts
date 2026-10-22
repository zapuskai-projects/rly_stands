import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comparePrimitives } from './doctor';

describe('comparePrimitives', () => {
  it('одинаковые списки совпадают', () => {
    const result = comparePrimitives(['a', 'b'], ['b', 'a']);
    assert.equal(result.verdict, 'ok');
    assert.match(result.text, /совпадает с платформой \(2\)/);
  });

  it('платформа знает больше — предупреждение с перечислением', () => {
    const result = comparePrimitives(['a'], ['a', 'bank.accounts', 'bank.ledger']);
    assert.equal(result.verdict, 'warn');
    assert.match(result.text, /bank\.accounts, bank\.ledger/);
  });

  it('в пульте больше, чем у платформы — не ошибка', () => {
    const result = comparePrimitives(['a', 'b'], ['a']);
    assert.equal(result.verdict, 'ok');
    assert.match(result.text, /шире/);
  });
});
