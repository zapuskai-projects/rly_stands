import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;

describe('заблокированный клиент', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const block = (phone: string) => h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE phone = $1", [phone]);

  it('вход закрыт: код не выдаётся, ответ 403 CLIENT_BLOCKED', async () => {
    await block(PETR);
    const response = await h.api(null, 'POST', '/api/v1/auth/login', { phone: PETR });
    assert.equal(response.status, 403);
    assert.equal(pick(response.body, 'code'), 'CLIENT_BLOCKED');
    const sms = await h.api(null, 'GET', `/api/v1/sandbox/sms?phone=${encodeURIComponent(PETR)}&limit=5`);
    assert.deepEqual(pick(sms.body, 'items'), []);
  });

  it('уже выданный токен не позволяет переводить: 403 CLIENT_BLOCKED, операция и проводки не создаются', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    await block(PETR);
    const response = await sendTransfer(h, petr, 'blocked-key-0001', phoneTransfer(from.number, ANNA, 10_000));
    assert.equal(response.status, 403);
    assert.equal(pick(response.body, 'code'), 'CLIENT_BLOCKED');
    const operations = await h.pool.query("SELECT COUNT(*)::int AS total FROM operations WHERE request_id <> 'seed-history'");
    assert.equal(operations.rows[0]?.total, 0);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('получатель-блокированный не находится ни в справочнике, ни в переводе по телефону', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    await block(PETR);
    const lookup = await h.api(anna, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(PETR)}`);
    assert.equal(lookup.status, 422);
    assert.equal(pick(lookup.body, 'code'), 'RECIPIENT_NOT_FOUND');
    const transfer = await sendTransfer(h, anna, 'blocked-key-0002', phoneTransfer(from.number, PETR, 10_000));
    assert.equal(transfer.status, 422);
    assert.equal(pick(transfer.body, 'code'), 'RECIPIENT_NOT_FOUND');
  });

  it('служебный перевод от имени заблокированного клиента отклоняется так же, как публичный', async () => {
    await block(PETR);
    const response = await h.kit('POST', '/_kit/actions/transfer', {
      phone: PETR,
      toPhone: ANNA,
      amountKop: 10_000,
      idempotencyKey: 'blocked-kit-0001',
      label: 'blocked:1',
    });
    assert.equal(response.status, 403);
    assert.equal(pick(response.body, 'code'), 'CLIENT_BLOCKED');
  });

  it('клиент вернулся в ACTIVE — вход и переводы работают снова', async () => {
    await block(PETR);
    await h.pool.query("UPDATE clients SET status = 'ACTIVE' WHERE phone = $1", [PETR]);
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const response = await sendTransfer(h, petr, 'blocked-key-0003', phoneTransfer(from.number, ANNA, 10_000));
    assert.equal(response.status, 201);
  });
});
