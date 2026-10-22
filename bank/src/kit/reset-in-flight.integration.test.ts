import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KIT_TEST_SECRET, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { NOON_MOSCOW, PHONES } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const CYCLES = 10;
const IN_FLIGHT = 12;

describe('сброс банка при работающих операциях', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const transfer = (cycle: number, index: number) =>
    h.kit('POST', '/_kit/actions/transfer', {
      phone: index % 2 === 0 ? ANNA : PETR,
      toPhone: index % 2 === 0 ? PETR : ANNA,
      amountKop: 1_000 + index,
      idempotencyKey: `inflight-${String(cycle).padStart(2, '0')}-${String(index).padStart(3, '0')}`,
      label: `inflight:${cycle}`,
    });

  it('сброс посреди переводов и разбора событий всегда отвечает 200, после него банк в исходном состоянии с верными проводками', async () => {
    const statuses: number[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const transfers = Promise.all(Array.from({ length: IN_FLIGHT }, (_, index) => transfer(cycle, index)));
      const handling = h.drain();
      await new Promise((resolve) => setTimeout(resolve, 20 * (cycle % 4)));
      statuses.push((await h.kit('POST', '/_kit/reset')).status);
      await transfers;
      await handling.catch(() => undefined);
    }
    assert.deepEqual([...new Set(statuses)], [200]);
    assert.equal(statuses.length, CYCLES);

    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    const clients = await h.pool.query('SELECT COUNT(*)::int AS total FROM clients');
    assert.equal(clients.rows[0]?.total, 6);
    const operations = await h.pool.query("SELECT COUNT(*)::int AS total FROM operations WHERE request_id <> 'seed-history'");
    assert.equal(operations.rows[0]?.total, 0);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });
});
