import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isValidAccountNumber } from '../accounts/account-number';
import { BANK } from '../shared/bank-identity';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { NOON_MOSCOW, PHONES } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA } = PHONES;

describe('технический клиент проверок', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const create = (body: Record<string, unknown> = { tariffCode: 'START', balanceKop: 1_000_000 }) =>
    h.kit('POST', '/_kit/actions/check-client', body);
  const technicalCount = async () => Number((await h.pool.query('SELECT COUNT(*)::int AS total FROM clients WHERE technical')).rows[0]?.total);
  const transfer = (phone: string, key: string, extra: Record<string, unknown> = {}) =>
    h.kit('POST', '/_kit/actions/transfer', { phone, toPhone: ANNA, amountKop: 10_000, idempotencyKey: key, label: 'check:1', ...extra });

  it('создаёт клиента «Проверка набора» с телефоном из своего диапазона, счётом и остатком', async () => {
    const response = await create({ tariffCode: 'PENSION', balanceKop: 2_500_000 });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body as object).sort(), ['accountNumber', 'phone']);
    const phone = String(pick(response.body, 'phone'));
    const account = String(pick(response.body, 'accountNumber'));
    assert.match(phone, /^\+7900999[0-9]{4}$/);
    assert.ok(isValidAccountNumber(BANK.bik, account));
    const client = await h.pool.query('SELECT full_name, tariff_code, technical FROM clients WHERE phone = $1', [phone]);
    assert.deepEqual(client.rows[0], { full_name: 'Проверка набора', tariff_code: 'PENSION', technical: true });
    const ledger = (await h.kit('GET', `/_kit/facts/ledger?account=${account}`)).body;
    assert.equal(pick(ledger, 'balanceKop'), 2_500_000);
    assert.equal(pick(ledger, 'consistent'), true);
  });

  it('каждый вызов заводит нового клиента; нулевой остаток допустим', async () => {
    const first = await create();
    const second = await create({ tariffCode: 'START', balanceKop: 0 });
    assert.notEqual(pick(first.body, 'phone'), pick(second.body, 'phone'));
    assert.notEqual(pick(first.body, 'accountNumber'), pick(second.body, 'accountNumber'));
    const empty = (await h.kit('GET', `/_kit/facts/ledger?account=${String(pick(second.body, 'accountNumber'))}`)).body;
    assert.equal(pick(empty, 'balanceKop'), 0);
    assert.equal(await technicalCount(), 2);
  });

  it('неизвестный тариф и неверные поля — 400 без создания клиента', async () => {
    assert.equal((await create({ tariffCode: 'GOLD', balanceKop: 1 })).status, 400);
    assert.equal((await create({ tariffCode: 'START', balanceKop: -1 })).status, 400);
    assert.equal((await create({ tariffCode: 'START', balanceKop: 10_000_000_001 })).status, 400);
    assert.equal((await create({ tariffCode: 'START', balanceKop: 1, extra: true })).status, 400);
    assert.equal((await create({ balanceKop: 1 })).status, 400);
    assert.equal(await technicalCount(), 0);
  });

  it('переводы от технического клиента проходят, их отдают facts, у настоящих клиентов истории не прибавляется', async () => {
    const phone = String(pick((await create()).body, 'phone'));
    const sent = await transfer(phone, 'check-key-0001');
    assert.equal(sent.status, 200);
    await h.drain();
    const operations = (await h.kit('GET', `/_kit/facts/operations?phone=${encodeURIComponent(phone)}`)).body as Record<string, unknown>[];
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.status, 'COMPLETED');
    assert.equal(operations[0]?.clientPhone, phone);
    const byLabel = (await h.kit('GET', '/_kit/facts/operations?label=check%3A1')).body as unknown[];
    assert.equal(byLabel.length, 1);
  });

  it('операции, клиент, уведомления и ручная проверка технического клиента не видны в списках офиса', async () => {
    const operator = await h.operatorLogin();
    const phone = String(pick((await create()).body, 'phone'));
    const officeClients = (await h.api(operator, 'GET', '/api/v1/office/clients?query=Проверка')).body;
    assert.equal(pick(officeClients, 'total'), 0);
    assert.equal(pick((await h.api(operator, 'GET', `/api/v1/office/clients?query=${phone}`)).body, 'total'), 0);
    const clientId = String((await h.pool.query('SELECT id FROM clients WHERE phone = $1', [phone])).rows[0]?.id);
    assert.equal((await h.api(operator, 'GET', `/api/v1/office/clients/${clientId}`)).status, 404);

    const operationsBefore = Number(pick((await h.api(operator, 'GET', '/api/v1/office/operations')).body, 'total'));
    const sent = await transfer(phone, 'check-key-0002', { amountKop: 20_000_000 });
    assert.equal(sent.status, 200);
    await h.drain();
    const operationNumber = String(pick(sent.body, 'number'));
    assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/operations')).body, 'total'), operationsBefore);
    assert.equal(pick((await h.api(operator, 'GET', `/api/v1/office/operations?number=${operationNumber}`)).body, 'total'), 0);
    const notifications = (await h.api(operator, 'GET', '/api/v1/office/notifications')).body;
    const items = (pick(notifications, 'items') as Array<Record<string, unknown>>) ?? [];
    assert.equal(items.some((item) => item.operationNumber === operationNumber || item.phone === phone), false);
    const reviews = (await h.api(operator, 'GET', '/api/v1/office/reviews')).body;
    const reviewItems = (pick(reviews, 'items') as Array<Record<string, unknown>>) ?? [];
    assert.equal(reviewItems.some((item) => item.operationNumber === operationNumber), false);
  });

  it('справочник получателей не знает технического клиента', async () => {
    const phone = String(pick((await create()).body, 'phone'));
    const token = await h.login(ANNA);
    const response = await h.api(token, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(phone)}`);
    assert.equal(response.status, 422);
    assert.equal(pick(response.body, 'code'), 'RECIPIENT_NOT_FOUND');
  });

  it('счёт технического клиента не попадает в список несошедшихся счетов, счёт настоящего клиента попадает', async () => {
    const account = String(pick((await create()).body, 'accountNumber'));
    await h.pool.query('UPDATE accounts SET balance_kop = balance_kop + 7 WHERE number = $1', [account]);
    assert.equal(pick((await h.kit('GET', `/_kit/facts/ledger?account=${account}`)).body, 'consistent'), false);
    const listed = async () =>
      (pick((await h.kit('GET', '/_kit/facts/ledger')).body, 'inconsistent') as Array<{ account: string }>).map((row) => row.account);
    assert.deepEqual(await listed(), []);
    const real = String((await h.pool.query("SELECT number FROM accounts WHERE kind = 'CURRENT' AND client_id IS NOT NULL AND client_id NOT IN (SELECT id FROM clients WHERE technical) LIMIT 1")).rows[0]?.number);
    await h.pool.query('UPDATE accounts SET balance_kop = balance_kop + 7 WHERE number = $1', [real]);
    assert.deepEqual(await listed(), [real]);
  });

  it('сброс удаляет технических клиентов вместе с их счетами и операциями', async () => {
    const phone = String(pick((await create()).body, 'phone'));
    await transfer(phone, 'check-key-0003');
    await h.drain();
    assert.equal(await technicalCount(), 1);
    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    assert.equal(await technicalCount(), 0);
    assert.equal(Number((await h.pool.query('SELECT COUNT(*)::int AS total FROM clients WHERE phone = $1', [phone])).rows[0]?.total), 0);
    const first = await create();
    assert.equal(pick(first.body, 'phone'), phone);
  });
});
