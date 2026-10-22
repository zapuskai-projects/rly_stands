import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, markCount, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, setDefects } from '../testing/scenarios';
import { DEFECT_CODES } from './catalog';
import { insertDefectMarks, listDefectMarks, loadActiveDefects, saveActiveDefects } from './defects.repository';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA } = PHONES;

describe('реестр включённых сбоев и пометок', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  it('по умолчанию не включено ничего, список читается сразу после записи', async () => {
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
    await setDefects(h, ['limit-boundary', 'limit-boundary', 'sbp-timeout-stuck']);
    assert.deepEqual([...(await loadActiveDefects(h.pool))].sort(), ['limit-boundary', 'sbp-timeout-stuck']);
    await setDefects(h, []);
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
  });

  it('неизвестный код не записывается, а чужая запись в базе не включает ничего', async () => {
    await assert.rejects(saveActiveDefects(h.pool, ['limit-boundary', 'нет-такого']), /Неизвестные коды/);
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
    await h.pool.query("UPDATE scenario SET defects = ARRAY['нет-такого']");
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
  });

  it('пометка на операции и сбое одна, повтор записи её не меняет', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const created = await sendTransfer(h, petr, 'registry-key-0001', phoneTransfer(from.number, ANNA, 100_000));
    const id = String(pick(created.body, 'id'));
    await insertDefectMarks(h.pool, id, [{ code: 'commission-rounding', details: { expected: 1, actual: 2 } }], NOON_MOSCOW);
    await insertDefectMarks(h.pool, id, [{ code: 'commission-rounding', details: { expected: 9, actual: 9 } }], new Date(NOON_MOSCOW.getTime() + 1000));
    const marks = await listDefectMarks(h.pool, id);
    assert.equal(marks.length, 1);
    assert.deepEqual(marks[0]?.details, { expected: 1, actual: 2 });
  });

  it('ни интерфейс банка, ни публичный API, ни офис не показывают сбои и пометки', async () => {
    await setDefects(h, [...DEFECT_CODES]);
    const petr = await h.login(PETR);
    const operator = await h.operatorLogin();
    const from = await accountOf(h, petr);
    const created = await sendTransfer(h, petr, 'registry-key-0002', phoneTransfer(from.number, ANNA, 15_000_000));
    await sendTransfer(h, petr, 'registry-key-0003', phoneTransfer(from.number, ANNA, 15_000_000));
    await h.drain();
    assert.ok((await markCount(h)) > 0);
    const id = String(pick(created.body, 'id'));
    const responses = [
      created,
      await h.api(petr, 'GET', `/api/v1/operations/${id}`),
      await h.api(petr, 'GET', '/api/v1/operations'),
      await h.api(petr, 'GET', '/api/v1/me'),
      await h.api(petr, 'GET', `/api/v1/accounts/${from.id}/statement?from=2026-10-20&to=2026-10-20`),
      await h.api(operator, 'GET', `/api/v1/office/operations/${id}`),
      await h.api(operator, 'GET', '/api/v1/office/operations'),
      await h.api(operator, 'GET', '/api/v1/office/reviews?state=ALL'),
    ];
    for (const response of responses) {
      const text = JSON.stringify(response.body).toLowerCase();
      assert.equal(text.includes('defect'), false);
      assert.equal(text.includes('mark'), false);
      for (const code of DEFECT_CODES) assert.equal(text.includes(code), false, code);
    }
  });
});
