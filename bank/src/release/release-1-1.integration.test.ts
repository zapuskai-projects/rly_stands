import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadAsyncApi } from '../testing/asyncapi';
import { autopayEvents, makeAutopayment, makeTemplate, tick } from '../testing/autopay';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, moscow, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, settledTransfer, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const SOME_ID = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const BASE = { label: 'release:run-1', defects: [], sbpMode: 'NORMAL', bankTime: null };

describe('релиз 1.1 не виден на релизе 1.0 и включается сценарием', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const scenario = (body: Record<string, unknown>) => h.kit('POST', '/_kit/scenario', { ...BASE, ...body });

  it('все маршруты шаблонов и автоплатежей отвечают как несуществующие, у любого клиента и оператора', async () => {
    const anna = await h.login(ANNA);
    const operator = await h.operatorLogin();
    const routes: [string, string, string, unknown?][] = [
      ['GET', '/api/v1/templates', anna],
      ['POST', '/api/v1/templates', anna, { name: 'Х', fromOperationId: SOME_ID }],
      ['PATCH', `/api/v1/templates/${SOME_ID}`, anna, { name: 'Х' }],
      ['DELETE', `/api/v1/templates/${SOME_ID}`, anna],
      ['POST', `/api/v1/templates/${SOME_ID}/transfers`, anna, {}],
      ['GET', '/api/v1/autopayments', anna],
      ['POST', '/api/v1/autopayments', anna, { templateId: SOME_ID, dayOfMonth: 5 }],
      ['POST', `/api/v1/autopayments/${SOME_ID}/pause`, anna],
      ['POST', `/api/v1/autopayments/${SOME_ID}/resume`, anna],
      ['DELETE', `/api/v1/autopayments/${SOME_ID}`, anna],
      ['GET', `/api/v1/autopayments/${SOME_ID}/runs`, anna],
      ['POST', `/api/v1/sandbox/autopayments/${SOME_ID}/run`, anna],
      ['GET', `/api/v1/office/clients/${SOME_ID}/templates`, operator],
      ['GET', `/api/v1/office/clients/${SOME_ID}/autopayments`, operator],
    ];
    for (const [method, route, token, body] of routes) {
      const response = await h.api(token, method, route, body, { 'Idempotency-Key': 'release-key-0001' });
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(pick(response.body, 'code'), 'NOT_FOUND', `${method} ${route}`);
    }
    assert.equal((await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: SOME_ID, label: 'release-1' })).status, 404);
    assert.equal((await h.kit('GET', '/_kit/facts/autopayments')).status, 404);
  });

  it('контракт, события и версия на 1.0 без следов; на 1.1 появляются', async () => {
    const openapi = await (await fetch(`${h.baseUrl}/api/openapi.yaml`)).text();
    const events = await (await fetch(`${h.baseUrl}/api/asyncapi.yaml`)).text();
    for (const text of [openapi, events]) assert.equal(/шаблон|автоплат|template|autopay|x-release/i.test(text), false);
    assert.equal(((await (await fetch(`${h.baseUrl}/health`)).json()) as { release: string }).release, '1.0');

    assert.equal((await scenario({ release: '1.1' })).status, 200);
    assert.ok((await (await fetch(`${h.baseUrl}/api/openapi.yaml`)).text()).includes('/api/v1/templates/{templateId}/transfers'));
    assert.ok((await (await fetch(`${h.baseUrl}/api/asyncapi.yaml`)).text()).includes('bank.autopayments.executed'));
    assert.equal(((await (await fetch(`${h.baseUrl}/health`)).json()) as { release: string }).release, '1.1');
    assert.equal((await h.api(await h.login(ANNA), 'GET', '/api/v1/templates')).status, 200);

    assert.equal((await scenario({})).status, 200);
    assert.equal((await h.api(await h.login(ANNA), 'GET', '/api/v1/templates')).status, 404);
  });

  it('операция, список операций и событие создания на 1.0 без templateId и по контракту 1.0', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const done = await settledTransfer(h, anna, 'release-plain-001', phoneTransfer(from.number, PETR, 100_000));
    assert.equal('templateId' in (done.body as object), false);
    const list = await h.api(anna, 'GET', '/api/v1/operations');
    assert.equal((pick(list.body, 'items') as object[]).some((item) => 'templateId' in item), false);
    const operator = await h.operatorLogin();
    const office = await h.api(operator, 'GET', `/api/v1/office/operations/${String(pick(done.body, 'id'))}`);
    assert.equal('templateId' in (pick(office.body, 'operation') as object), false);
    const created = h.events.filter((event) => event.topic === 'bank.payments.created');
    assert.equal(created.length, 1);
    assert.equal('templateId' in (created[0]?.payload as object), false);
    assert.equal(loadAsyncApi('1.0').payloadValidator('bank.payments.created')(created[0]?.payload).ok, true);
    const facts = await h.kit('GET', `/_kit/facts/operations/${String(pick(done.body, 'number'))}`);
    assert.equal('templateId' in (facts.body as object), false);
  });

  it('данные автоплатежа в базе при релизе 1.0 не двигаются: планировщик ничего не исполняет, при возврате на 1.1 исполняет', async () => {
    await useRelease(h, '1.1');
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const templateId = await makeTemplate(h, anna, { name: 'Аренда', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount: 2_500_000 });
    const id = String(pick((await makeAutopayment(h, anna, { templateId, dayOfMonth: 21 })).body, 'id'));
    await useRelease(h, '1.0');
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await h.autopay(), { started: 0, advanced: 0, reminded: 0, finished: 0 });
    assert.equal((await h.pool.query('SELECT 1 FROM autopayment_runs')).rowCount, 0);
    assert.equal(autopayEvents(h).length, 0);
    assert.equal((await accountOf(h, anna)).balance, from.balance);

    await useRelease(h, '1.1');
    await tick(h);
    assert.equal((await h.pool.query('SELECT 1 FROM autopayment_runs WHERE autopayment_id = $1', [id])).rowCount, 1);
    assert.equal((await accountOf(h, anna)).balance, from.balance - 2_500_000);
  });

  it('операция, созданная на 1.0, после включения 1.1 получает templateId: null', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const before = await sendTransfer(h, anna, 'release-plain-002', phoneTransfer(from.number, PETR, 100_000));
    await useRelease(h, '1.1');
    const after = await h.api(anna, 'GET', `/api/v1/operations/${String(pick(before.body, 'id'))}`);
    assert.equal(pick(after.body, 'templateId'), null);
  });
});
