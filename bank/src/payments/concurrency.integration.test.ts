import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NOON_MOSCOW, operationOf, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR, SERGEY } = PHONES;
const PAIRS = 20;
const AMOUNT = 10_000;

describe('параллельные переводы', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  it('20 встречных пар переводов двух клиентов одновременно проходят без взаимной блокировки, остатки не меняются, проводки сходятся', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const annaAccount = await accountOf(h, anna);
    const petrAccount = await accountOf(h, petr);

    const responses = await Promise.all(
      Array.from({ length: PAIRS }, (_, index) => [
        sendTransfer(h, anna, `opp-anna-${String(index).padStart(3, '0')}-key`, phoneTransfer(annaAccount.number, PETR, AMOUNT)),
        sendTransfer(h, petr, `opp-petr-${String(index).padStart(3, '0')}-key`, phoneTransfer(petrAccount.number, ANNA, AMOUNT)),
      ]).flat(),
    );
    assert.equal(responses.length, PAIRS * 2);
    assert.deepEqual([...new Set(responses.map((response) => response.status))], [201]);

    await h.drain();
    const statuses = await Promise.all(
      responses.map(async (response, index) => pick((await operationOf(h, index % 2 === 0 ? anna : petr, response)).body, 'status')),
    );
    assert.deepEqual([...new Set(statuses)], ['COMPLETED']);
    assert.equal((await accountOf(h, anna)).balance, annaAccount.balance);
    assert.equal((await accountOf(h, petr)).balance, petrAccount.balance);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('одновременные переводы одного клиента разным получателям не теряют деньги и не уходят в минус', async () => {
    const anna = await h.login(ANNA);
    const annaAccount = await accountOf(h, anna);
    const targets = [PETR, SERGEY];
    const responses = await Promise.all(
      Array.from({ length: PAIRS }, (_, index) =>
        sendTransfer(h, anna, `solo-anna-${String(index).padStart(3, '0')}-key`, phoneTransfer(annaAccount.number, targets[index % 2] as string, AMOUNT)),
      ),
    );
    assert.deepEqual([...new Set(responses.map((response) => response.status))], [201]);
    await h.drain();
    assert.equal((await accountOf(h, anna)).balance, annaAccount.balance - PAIRS * AMOUNT);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });
});
