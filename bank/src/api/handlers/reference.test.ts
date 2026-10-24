import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { releaseSource } from '../../release/release-source';
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

const release = releaseSource(async () => '1.1');

const run = (handlers: ReturnType<typeof referenceHandlers>) => (handlers.getHealth as Handler)({} as HandlerContext);

describe('состояние банка', () => {
  it('база недоступна — 503, обе части DOWN', async () => {
    assert.deepEqual(await run(referenceHandlers(pool(false), release)), { status: 503, body: { status: 'DOWN', database: 'DOWN' } });
  });

  it('база работает, а потребитель событий ещё не в группе — 503 с базой UP', async () => {
    const readiness = new Readiness();
    let inGroup = false;
    readiness.add('потребитель', () => inGroup);
    const handlers = referenceHandlers(pool(true), release, readiness);
    assert.deepEqual(await run(handlers), { status: 503, body: { status: 'DOWN', database: 'UP' } });
    inGroup = true;
    assert.deepEqual(await run(handlers), { status: 200, body: { status: 'UP', database: 'UP', release: '1.1' } });
  });

  it('без учёта готовности (как в тестах API) отвечает по базе', async () => {
    assert.deepEqual(await run(referenceHandlers(pool(true), release)), { status: 200, body: { status: 'UP', database: 'UP', release: '1.1' } });
  });
});
