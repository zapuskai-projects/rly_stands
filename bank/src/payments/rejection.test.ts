import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { evaluateRejection, type RejectionInput } from './rejection';

const base: RejectionInput = {
  type: 'PHONE_TRANSFER',
  route: 'INTERNAL',
  accountStatus: 'ACTIVE',
  clientResident: true,
  amount: rubles(1_000),
  dailyLimit: rubles(150_000),
  usedToday: 0n,
};

describe('отказы по правилам банка', () => {
  it('обычный перевод не отклоняется', () => {
    assert.equal(evaluateRejection(base), null);
  });

  it('арест счёта отклоняет любой расход, включая перевод между своими счетами', () => {
    assert.equal(evaluateRejection({ ...base, accountStatus: 'ARRESTED' })?.code, 'ACCOUNT_ARRESTED');
    assert.equal(evaluateRejection({ ...base, type: 'OWN_TRANSFER', accountStatus: 'ARRESTED' })?.code, 'ACCOUNT_ARRESTED');
  });

  it('нерезидент не может переводить в другой банк, но может внутри банка', () => {
    assert.equal(evaluateRejection({ ...base, clientResident: false, route: 'SBP' })?.code, 'NON_RESIDENT_EXTERNAL_TRANSFER');
    assert.equal(evaluateRejection({ ...base, clientResident: false, route: 'INTERNAL' }), null);
  });

  it('лимит: ровно до границы проходит, на копейку больше — отказ', () => {
    const atLimit = { ...base, amount: rubles(150_000) };
    assert.equal(evaluateRejection(atLimit), null);
    assert.equal(evaluateRejection({ ...atLimit, amount: rubles(150_000) + 1n })?.code, 'DAILY_LIMIT_EXCEEDED');
  });

  it('лимит учитывает уже переведённое за сутки', () => {
    const used = { ...base, usedToday: rubles(149_000), amount: rubles(1_000) };
    assert.equal(evaluateRejection(used), null);
    assert.equal(evaluateRejection({ ...used, amount: rubles(1_000) + 1n })?.code, 'DAILY_LIMIT_EXCEEDED');
  });

  it('перевод между своими счетами лимитом не ограничен', () => {
    assert.equal(evaluateRejection({ ...base, type: 'OWN_TRANSFER', amount: rubles(900_000) }), null);
  });

  it('в сообщении об отказе по лимиту указан остаток', () => {
    const rejection = evaluateRejection({ ...base, usedToday: rubles(149_000), amount: rubles(5_000) });
    assert.match(rejection?.message ?? '', /1 000,00 ₽/);
  });

  it('арест проверяется раньше лимита, запрет нерезидента раньше лимита', () => {
    assert.equal(evaluateRejection({ ...base, accountStatus: 'ARRESTED', amount: rubles(900_000) })?.code, 'ACCOUNT_ARRESTED');
    assert.equal(
      evaluateRejection({ ...base, clientResident: false, route: 'SBP', amount: rubles(900_000) })?.code,
      'NON_RESIDENT_EXTERNAL_TRANSFER',
    );
  });

  it('строгая граница лимита отклоняет перевод ровно на остаток лимита', () => {
    const atLimit = { ...base, amount: rubles(150_000) };
    assert.equal(evaluateRejection(atLimit), null);
    assert.equal(evaluateRejection({ ...atLimit, strictLimit: false }), null);
    assert.equal(evaluateRejection({ ...atLimit, strictLimit: true })?.code, 'DAILY_LIMIT_EXCEEDED');
    assert.equal(evaluateRejection({ ...base, amount: rubles(150_000) - 1n, strictLimit: true }), null);
  });
});
