import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { BankClock } from '../clock/bank-clock';
import { resetBank } from './reset';

const conflict = (code: string) => Object.assign(new Error(`ошибка ${code}`), { code });

function fakePool(failures: Array<Error | null>) {
  const log: string[] = [];
  let truncates = 0;
  const query = async (sql: string) => {
    log.push((sql.split('\n')[0] ?? '').slice(0, 40));
    if (sql.startsWith('TRUNCATE')) {
      const failure = failures[truncates];
      truncates += 1;
      if (failure) throw failure;
    }
    if (sql.includes('FROM clients')) return { rows: [{ total: 1n }] };
    return { rows: [] };
  };
  const pool = { connect: async () => ({ query, release: () => undefined }), query } as unknown as Pool;
  return { pool, log, truncates: () => truncates };
}

describe('сброс банка', () => {
  it('взаимная блокировка с фоновой работой не роняет сброс: транзакция повторяется целиком', async () => {
    const { pool, log, truncates } = fakePool([conflict('40P01'), conflict('55P03'), null]);
    await resetBank({ pool, clock: new BankClock() });
    assert.equal(truncates(), 3);
    assert.equal(log.filter((entry) => entry === 'ROLLBACK').length, 2);
    assert.ok(log.includes("SET LOCAL lock_timeout = '3s'"));
  });

  it('после успешного сброса вызывается очистка топиков, после неудачного нет', async () => {
    const calls: string[] = [];
    const afterReset = async () => {
      calls.push('afterReset');
    };
    await resetBank({ pool: fakePool([null]).pool, clock: new BankClock(), afterReset });
    assert.deepEqual(calls, ['afterReset']);
    await assert.rejects(resetBank({ pool: fakePool([conflict('23505')]).pool, clock: new BankClock(), afterReset }), /23505/);
    assert.deepEqual(calls, ['afterReset']);
  });

  it('другая ошибка сразу уходит наружу', async () => {
    const { pool, truncates } = fakePool([conflict('23505')]);
    await assert.rejects(resetBank({ pool, clock: new BankClock() }), /23505/);
    assert.equal(truncates(), 1);
  });
});
