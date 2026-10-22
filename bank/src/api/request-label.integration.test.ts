import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA } = PHONES;

describe('метка попытки из сценария', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const activate = (label: string) =>
    h.kit('POST', '/_kit/scenario', { label, defects: [], sbpMode: 'NORMAL', bankTime: null });

  async function transfer(key: string, headers: Record<string, string> = {}) {
    const token = await h.login(PETR);
    const from = await accountOf(h, token);
    return sendTransfer(h, token, key, phoneTransfer(from.number, ANNA, 100_00), headers);
  }

  const labelOf = async (operationId: string) =>
    (await h.pool.query<{ attempt_label: string | null }>('SELECT attempt_label FROM operations WHERE id = $1', [operationId])).rows[0]?.attempt_label ?? null;

  it('перевод без заголовка получает метку активного сценария: и операция, и журнал запросов', async () => {
    await activate('scenario-label');
    const created = await transfer('label-key-0001');
    assert.equal(created.status, 201);
    assert.equal(await labelOf(String(pick(created.body, 'id'))), 'scenario-label');
    await h.drain();
    const facts = await h.kit('GET', '/_kit/facts/operations?label=scenario-label');
    assert.equal((facts.body as unknown[]).length, 1);
    const requests = await h.kit('GET', '/_kit/facts/requests?label=scenario-label');
    assert.ok((requests.body as Array<{ path: string }>).some((item) => item.path === '/api/v1/transfers'));
  });

  it('заголовок главнее метки сценария', async () => {
    await activate('scenario-label');
    const created = await transfer('label-key-0002', { 'X-Attempt-Label': 'header-label' });
    assert.equal(await labelOf(String(pick(created.body, 'id'))), 'header-label');
  });

  it('сценария нет или он сброшен — операция без метки', async () => {
    const before = await transfer('label-key-0003');
    assert.equal(await labelOf(String(pick(before.body, 'id'))), null);
    await activate('scenario-label');
    await h.kit('POST', '/_kit/reset', {});
    const after = await transfer('label-key-0004');
    assert.equal(await labelOf(String(pick(after.body, 'id'))), null);
  });

  it('метка сценария попадает и в чтения: операция находится по ней', async () => {
    await activate('scenario-label');
    const token = await h.login(PETR);
    await h.api(token, 'GET', '/api/v1/accounts');
    const requests = await h.kit('GET', '/_kit/facts/requests?label=scenario-label');
    assert.ok((requests.body as Array<{ path: string }>).some((item) => item.path === '/api/v1/accounts'));
  });
});
