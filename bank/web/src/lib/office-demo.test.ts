import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATOR_SEEDS } from '../../../src/seed/operators';
import { OFFICE_DEMO_ACCOUNTS } from './office-demo';

describe('учётки тестового контура на экране входа в офис', () => {
  it('берутся из тех же записей, которыми банк заводит операторов, с подписью роли', () => {
    assert.deepEqual(OFFICE_DEMO_ACCOUNTS, [
      { login: 'operator', password: 'operator-2026', role: 'Оператор' },
      { login: 'senior', password: 'senior-2026', role: 'Старший оператор' },
    ]);
    assert.equal(OFFICE_DEMO_ACCOUNTS.length, OPERATOR_SEEDS.length);
    for (const seed of OPERATOR_SEEDS) {
      assert.ok(OFFICE_DEMO_ACCOUNTS.some((account) => account.login === seed.login && account.password === seed.password));
    }
  });
});
