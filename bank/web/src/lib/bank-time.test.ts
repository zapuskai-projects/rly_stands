import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { bankDateKey, bankNowIso, bankNowMs, moscowHour, moscowIso, noteBankTime, resetBankTime } from './bank-time';

describe('время банка в браузере', () => {
  afterEach(() => {
    resetBankTime();
  });

  it('метка времени выводится со смещением +03:00', () => {
    assert.equal(moscowIso(Date.parse('2026-10-20T20:40:12.007Z')), '2026-10-20T23:40:12.007+03:00');
    assert.equal(moscowHour(Date.parse('2026-10-20T20:40:00Z')), 23);
  });

  it('без ответа банка время равно времени компьютера', () => {
    assert.equal(bankNowMs(1_000_000), 1_000_000);
  });

  it('после ответа банка время идёт от его метки, даже если часы банка сдвинуты', () => {
    noteBankTime('2026-10-20T23:40:00.000+03:00', 5_000);
    assert.equal(bankNowIso(5_000), '2026-10-20T23:40:00.000+03:00');
    assert.equal(bankNowIso(65_000), '2026-10-20T23:41:00.000+03:00');
    assert.equal(bankDateKey(5_000 + 20 * 60 * 1000), '2026-10-21');
  });

  it('пустой или испорченный заголовок игнорируется', () => {
    noteBankTime(null, 1);
    noteBankTime('не дата', 1);
    assert.equal(bankNowMs(10), 10);
  });
});
