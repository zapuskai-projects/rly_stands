import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadContract, type Contract } from '../api/contract';
import { DOCS_DIR } from '../config';
import { KIT_TEST_SECRET, pick, startHarness, type ApiResponse, type Harness } from '../testing/harness';
import { NOON_MOSCOW, PHONES } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA } = PHONES;

describe('служебный API банка совпадает с kit-api.yaml', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let contract: Contract;

  beforeEach(async () => {
    contract = loadContract(path.join(DOCS_DIR, 'kit-api.yaml'));
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  function conforms(operationId: string, response: ApiResponse, request?: unknown): void {
    const operation = contract.operations.find((item) => item.operationId === operationId);
    assert.ok(operation, operationId);
    if (request !== undefined) {
      const body = operation.body?.validator.validate(request);
      assert.equal(body?.ok, true, `${operationId}: запрос ${JSON.stringify(body)}`);
    }
    assert.ok(operation.responses.has(response.status), `${operationId}: статус ${response.status} не описан`);
    const check = operation.responses.get(response.status)?.validate(response.body);
    assert.equal(check?.ok, true, `${operationId} ${response.status}: ${JSON.stringify(check)}`);
  }

  it('каждый маршрут с реальными данными отвечает по описанию', async () => {
    const scenario = {
      label: 'task-6:contract',
      defects: ['commission-rounding'],
      sbpMode: 'NORMAL',
      bankTime: '2026-10-20T23:40:00+03:00',
      tariffs: [{ code: 'START', dailyLimitKop: 15_000_000 }],
      personas: [{ phone: ANNA, dailyLimitKop: null }],
    };
    conforms('kitScenario', await h.kit('POST', '/_kit/scenario', scenario), scenario);
    conforms('kitScenario', await h.kit('POST', '/_kit/scenario', { ...scenario, defects: ['нет-такого'] }));
    conforms('kitScenario', await h.kit('POST', '/_kit/scenario', { ...scenario, tariffs: [{ code: 'GOLD' }] }));
    conforms('kitScenario', await h.kit('GET', '/_kit/none'));

    const held = { phone: ANNA, toPhone: PETR, amountKop: 1_500_000, idempotencyKey: 'kit-con-0001', label: 'task-6:contract' };
    const created = await h.kit('POST', '/_kit/actions/transfer', held);
    conforms('kitTransfer', created, held);
    conforms('kitTransfer', await h.kit('POST', '/_kit/actions/transfer', { ...held, phone: '+79990000000' }));
    conforms('kitTransfer', await h.kit('POST', '/_kit/actions/transfer', { ...held, amountKop: 14_000_000_000, idempotencyKey: 'kit-con-0002' }));
    conforms('kitTransfer', await h.kit('POST', '/_kit/actions/transfer', { amountKop: 0 }));
    await h.drain();

    const tariff = { code: 'PENSION', rateBps: 150, minKop: 2_000 };
    conforms('kitSetTariff', await h.kit('POST', '/_kit/actions/set-tariff', tariff), tariff);
    conforms('kitSetTariff', await h.kit('POST', '/_kit/actions/set-tariff', { code: 'GOLD' }));
    conforms('kitSetTariff', await h.kit('POST', '/_kit/actions/set-tariff', { code: 'START', minKop: 999_999_999 }));
    const checkClient = { tariffCode: 'START', balanceKop: 500_000 };
    conforms('kitCheckClient', await h.kit('POST', '/_kit/actions/check-client', checkClient), checkClient);
    conforms('kitCheckClient', await h.kit('POST', '/_kit/actions/check-client', { tariffCode: 'GOLD', balanceKop: 1 }));
    conforms('kitCheckClient', await h.kit('POST', '/_kit/actions/check-client', { balanceKop: -1 }));
    conforms('kitTariff', await h.kit('GET', '/_kit/facts/tariffs/START'));
    conforms('kitTariff', await h.kit('GET', '/_kit/facts/tariffs/GOLD'));
    conforms('kitClock', await h.kit('GET', '/_kit/facts/clock'));

    const review = { operationId: pick(created.body, 'operationId'), decision: 'APPROVE', comment: 'Подтверждено' };
    conforms('kitReview', await h.kit('POST', '/_kit/actions/review', review), review);
    conforms('kitReview', await h.kit('POST', '/_kit/actions/review', review));
    conforms('kitReview', await h.kit('POST', '/_kit/actions/review', { ...review, operationId: '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10' }));
    conforms('kitReview', await h.kit('POST', '/_kit/actions/review', { decision: 'MAYBE' }));
    await h.drain();

    const number = String(pick(created.body, 'number'));
    conforms('kitOperations', await h.kit('GET', '/_kit/facts/operations?label=task-6%3Acontract&status=COMPLETED'));
    conforms('kitOperations', await h.kit('GET', '/_kit/facts/operations?status=DONE'));
    conforms('kitOperation', await h.kit('GET', `/_kit/facts/operations/${number}`));
    conforms('kitOperation', await h.kit('GET', '/_kit/facts/operations/ZB9999999999'));
    const accountNumber = (await h.pool.query<{ number: string }>("SELECT number FROM accounts WHERE kind = 'CURRENT' LIMIT 1")).rows[0]?.number as string;
    conforms('kitLedger', await h.kit('GET', `/_kit/facts/ledger?account=${accountNumber}`));
    conforms('kitLedger', await h.kit('GET', '/_kit/facts/ledger'));
    conforms('kitLedger', await h.kit('GET', '/_kit/facts/ledger?account=40817810800000009999'));
    conforms('kitLedger', await h.kit('GET', '/_kit/facts/ledger?account=1'));
    conforms('kitRequests', await h.kit('GET', '/_kit/facts/requests?label=task-6%3Acontract'));
    conforms('kitRequests', await h.kit('GET', '/_kit/facts/requests'));
    const reset = await h.kit('POST', '/_kit/reset');
    conforms('kitReset', reset);
    assert.deepEqual(reset.body, { reset: true });
  });

  it('маршруты релиза 1.1 отвечают по описанию: 404 до релиза, после него запуск, факты, неверные запросы', async () => {
    conforms('kitAutopayRun', await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', label: 'task-6:auto' }));
    conforms('kitAutopayments', await h.kit('GET', '/_kit/facts/autopayments'));
    await h.pool.query("UPDATE scenario SET release = '1.1' WHERE id = 1");
    const token = await h.login(ANNA);
    const accounts = await h.api(token, 'GET', '/api/v1/accounts');
    const from = (pick(accounts.body, 'items') as { number: string }[])[0]?.number;
    const template = await h.api(token, 'POST', '/api/v1/templates', { name: 'Пётр', kind: 'PHONE', fromAccount: from, recipientPhone: PETR, amount: 100_000 });
    const autopayment = await h.api(token, 'POST', '/api/v1/autopayments', { templateId: pick(template.body, 'id'), dayOfMonth: 25 });
    const run = { autopaymentId: pick(autopayment.body, 'id'), label: 'task-6:auto' };
    conforms('kitAutopayRun', await h.kit('POST', '/_kit/actions/autopay-run', run), run);
    conforms('kitAutopayRun', await h.kit('POST', '/_kit/actions/autopay-run', run));
    conforms('kitAutopayRun', await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', label: 'task-6:auto' }));
    conforms('kitAutopayRun', await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: 'x' }));
    await h.drain();
    conforms('kitAutopayments', await h.kit('GET', '/_kit/facts/autopayments'));
    conforms('kitAutopayments', await h.kit('GET', `/_kit/facts/autopayments?phone=${encodeURIComponent(ANNA)}`));
    conforms('kitAutopayments', await h.kit('GET', '/_kit/facts/autopayments?phone=1'));
    conforms('kitOperations', await h.kit('GET', '/_kit/facts/operations?label=task-6%3Aauto'));
  });

  it('описание содержит ровно маршруты банка', () => {
    assert.deepEqual(
      contract.operations.map((item) => `${item.method.toUpperCase()} ${item.openApiPath}`).sort(),
      [
        'GET /_kit/facts/autopayments',
        'GET /_kit/facts/clock',
        'GET /_kit/facts/ledger',
        'GET /_kit/facts/operations',
        'GET /_kit/facts/operations/{idOrNumber}',
        'GET /_kit/facts/requests',
        'GET /_kit/facts/tariffs/{code}',
        'POST /_kit/actions/autopay-run',
        'POST /_kit/actions/check-client',
        'POST /_kit/actions/review',
        'POST /_kit/actions/set-tariff',
        'POST /_kit/actions/transfer',
        'POST /_kit/reset',
        'POST /_kit/scenario',
      ],
    );
  });

  it('маршруты релиза 1.1 помечены в описании служебного API', () => {
    const marked = contract.operations.filter((item) => item.release === '1.1').map((item) => item.operationId).sort();
    assert.deepEqual(marked, ['kitAutopayRun', 'kitAutopayments']);
  });

  it('служебные маршруты и их описание не видны ни в документации, ни в публичном контракте', async () => {
    const docs = await fetch(`${h.baseUrl}/docs-content`);
    assert.equal((await docs.text()).includes('kit'), false);
    for (const url of ['/api/kit-api.yaml', '/docs-content/kit-api', '/kit-api.yaml', '/docs/kit-api.yaml']) {
      assert.equal((await fetch(`${h.baseUrl}${url}`)).status, 404, url);
    }
    const publicContract = await fetch(`${h.baseUrl}/api/openapi.yaml`);
    assert.equal((await publicContract.text()).includes('_kit'), false);
  });
});
