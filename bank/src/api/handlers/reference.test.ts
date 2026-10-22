import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { Readiness } from '../../shared/readiness';
import type { Handler, HandlerContext } from '../router';
import { referenceHandlers } from './reference';

const pool = (alive: boolean) =>
  ({
    query: async () => {
      if (!alive) throw new Error('нет соединения');
      return { rows: [] };
    },
  }) as unknown as Pool;

const run = (handlers: ReturnType<typeof referenceHandlers>) => (handlers.getHealth as Handler)({} as HandlerContext);

describe('состояние банка', () => {
  it('база недоступна — 503, обе части DOWN', async () => {
    assert.deepEqual(await run(referenceHandlers(pool(false))), { status: 503, body: { status: 'DOWN', database: 'DOWN' } });
  });

  it('база работает, а потребитель событий ещё не в группе — 503 с базой UP', async () => {
    const readiness = new Readiness();
    let inGroup = false;
    readiness.add('потребитель', () => inGroup);
    const handlers = referenceHandlers(pool(true), readiness);
    assert.deepEqual(await run(handlers), { status: 503, body: { status: 'DOWN', database: 'UP' } });
    inGroup = true;
    assert.deepEqual(await run(handlers), { status: 200, body: { status: 'UP', database: 'UP' } });
  });

  it('без учёта готовности (как в тестах API) отвечает по базе', async () => {
    assert.deepEqual(await run(referenceHandlers(pool(true))), { status: 200, body: { status: 'UP', database: 'UP' } });
  });
});
