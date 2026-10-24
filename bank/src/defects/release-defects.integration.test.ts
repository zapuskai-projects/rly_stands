import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { autopaymentOf, makeAutopayment, makeTemplate, runsOf, tick } from '../testing/autopay';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, marksOf, markCount, moscow, NOON_MOSCOW, operationOf, PHONES, phoneTransfer, sendTransfer, setDefects, settledTransfer, useRelease } from '../testing/scenarios';
import { loadActiveDefects } from './defects.repository';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;

describe('дефекты релиза 1.1, включаемые сценарием', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    await useRelease(h, '1.1');
  });

  afterEach(async () => {
    await h.close();
  });

  const byTemplate = (token: string, id: string, key: string, body?: unknown) =>
    h.api(token, 'POST', `/api/v1/templates/${id}/transfers`, body, { 'Idempotency-Key': key });

  describe('template-skips-limit', () => {
    async function limitUsed() {
      const token = await h.login(PETR);
      const from = await accountOf(h, token);
      const templateId = await makeTemplate(h, token, { name: 'Анне', kind: 'PHONE', fromAccount: from.number, recipientPhone: ANNA });
      const spent = await byTemplate(token, templateId, 'skip-limit-0001', { amount: 15_000_000 });
      assert.equal(spent.status, 201);
      await h.drain();
      return { token, from, templateId };
    }

    it('без сбоя перевод по шаблону сверх суточного лимита отклоняется, пометки нет', async () => {
      const { token, templateId } = await limitUsed();
      const over = await byTemplate(token, templateId, 'skip-limit-0002', { amount: 1 });
      assert.equal(pick(over.body, 'status'), 'REJECTED');
      assert.equal(pick(over.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем перевод по шаблону сверх лимита проходит с пометкой, обычный перевод по-прежнему отклоняется без пометки', async () => {
      const { token, from, templateId } = await limitUsed();
      await setDefects(h, ['template-skips-limit']);
      const over = await byTemplate(token, templateId, 'skip-limit-0003', { amount: 100_000 });
      assert.equal(pick(over.body, 'status'), 'CHECKING');
      await h.drain();
      assert.equal(pick((await operationOf(h, token, over)).body, 'status'), 'COMPLETED');
      const marks = await marksOf(h, over);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details.expected, mark.details.actual, mark.details.limit, mark.details.usedToday, mark.details.amount]), [
        ['template-skips-limit', 'DAILY_LIMIT_EXCEEDED', 'ACCEPTED', 15_000_000, 15_000_000, 100_000],
      ]);
      const plain = await sendTransfer(h, token, 'skip-limit-0004', phoneTransfer(from.number, ANNA, 100_000));
      assert.equal(pick(plain.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
      assert.deepEqual(await marksOf(h, plain), []);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('со сбоем перевод по шаблону в пределах лимита проходит без пометки', async () => {
      await setDefects(h, ['template-skips-limit']);
      const token = await h.login(PETR);
      const from = await accountOf(h, token);
      const templateId = await makeTemplate(h, token, { name: 'Анне', kind: 'PHONE', fromAccount: from.number, recipientPhone: ANNA, amount: 100_000 });
      const ok = await byTemplate(token, templateId, 'skip-limit-0005');
      assert.deepEqual(await marksOf(h, ok), []);
    });
  });

  describe('template-ignores-amount', () => {
    async function template() {
      const token = await h.login(ANNA);
      const from = await accountOf(h, token);
      const templateId = await makeTemplate(h, token, { name: 'Пётр', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount: 100_000 });
      return { token, from, templateId };
    }

    it('без сбоя сумма запроса заменяет сумму шаблона, пометки нет', async () => {
      const { token, templateId } = await template();
      const changed = await byTemplate(token, templateId, 'ignore-amount-01', { amount: 130_000 });
      assert.equal(pick(changed.body, 'amount'), 130_000);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем перевод с изменённой суммой проводится на сумму шаблона с пометкой', async () => {
      const { token, from, templateId } = await template();
      await setDefects(h, ['template-ignores-amount']);
      const changed = await byTemplate(token, templateId, 'ignore-amount-02', { amount: 130_000 });
      assert.equal(changed.status, 201);
      assert.equal(pick(changed.body, 'amount'), 100_000);
      assert.deepEqual((await marksOf(h, changed)).map((mark) => [mark.code, mark.details.expected, mark.details.actual, mark.details.templateId]), [
        ['template-ignores-amount', 130_000, 100_000, templateId],
      ]);
      await h.drain();
      assert.equal((await accountOf(h, token)).balance, from.balance - 100_000);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('со сбоем перевод без суммы в запросе или с той же суммой идёт как обычно, без пометки', async () => {
      const { token, templateId } = await template();
      await setDefects(h, ['template-ignores-amount']);
      const plain = await byTemplate(token, templateId, 'ignore-amount-03');
      const same = await byTemplate(token, templateId, 'ignore-amount-04', { amount: 100_000 });
      assert.deepEqual([pick(plain.body, 'amount'), pick(same.body, 'amount')], [100_000, 100_000]);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем у шаблона без суммы запрошенная сумма действует', async () => {
      const token = await h.login(ANNA);
      const from = await accountOf(h, token);
      const templateId = await makeTemplate(h, token, { name: 'Без суммы', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR });
      await setDefects(h, ['template-ignores-amount']);
      const created = await byTemplate(token, templateId, 'ignore-amount-05', { amount: 130_000 });
      assert.equal(pick(created.body, 'amount'), 130_000);
      assert.equal(await markCount(h), 0);
    });
  });

  describe('autopay-no-retry', () => {
    async function broke(amount: number) {
      const token = await h.login(ANNA);
      const from = await accountOf(h, token);
      const templateId = await makeTemplate(h, token, { name: 'Кредит', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount });
      const id = String(pick((await makeAutopayment(h, token, { templateId, dayOfMonth: 21 })).body, 'id'));
      return { token, id };
    }

    const runFacts = async (id: string) => {
      const facts = await h.kit('GET', `/_kit/facts/autopayments?autopaymentId=${id}`);
      return (pick(facts.body, 'autopayments.0.runs') as { attempt: number; defects: { code: string; details: Record<string, unknown> }[] }[]);
    };

    it('без сбоя нехватка денег даёт повтор на следующий день, пометок нет', async () => {
      const { token, id } = await broke(13_000_000);
      h.setTime(moscow('2026-10-21T10:00:00'));
      await tick(h);
      const state = await autopaymentOf(h, token, id);
      assert.deepEqual([state.status, state.attempt, state.nextRunOn], ['ACTIVE', 1, '2026-10-22']);
      assert.deepEqual((await runFacts(id)).map((run) => run.defects), [[]]);
    });

    it('со сбоем нехватка денег сразу останавливает автоплатёж, повторов нет, пометка на запуске', async () => {
      await setDefects(h, ['autopay-no-retry']);
      const { token, id } = await broke(13_000_000);
      h.setTime(moscow('2026-10-21T10:00:00'));
      await tick(h);
      const state = await autopaymentOf(h, token, id);
      assert.deepEqual([state.status, state.attempt, state.nextRunOn, state.failureReason], ['FAILED', 1, null, 'INSUFFICIENT_FUNDS']);
      h.setTime(moscow('2026-10-22T10:00:00'));
      await tick(h);
      assert.equal((await runsOf(h, token, id)).length, 1);
      const [run] = await runFacts(id);
      assert.deepEqual(run?.defects, [{ code: 'autopay-no-retry', details: { expected: 'RETRY', actual: 'FAILED', reasonCode: 'INSUFFICIENT_FUNDS', attempt: 1 } }]);
    });

    it('со сбоем отказ по суточному лимиту по-прежнему повторяется без пометки', async () => {
      await setDefects(h, ['autopay-no-retry']);
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const templateId = await makeTemplate(h, petr, { name: 'Анне', kind: 'PHONE', fromAccount: from.number, recipientPhone: ANNA, amount: 6_000_000 });
      const id = String(pick((await makeAutopayment(h, petr, { templateId, dayOfMonth: 21 })).body, 'id'));
      h.setTime(moscow('2026-10-21T09:30:00'));
      await settledTransfer(h, petr, 'no-retry-limit-01', phoneTransfer(from.number, ANNA, 10_000_000));
      h.setTime(moscow('2026-10-21T10:00:00'));
      await tick(h);
      assert.deepEqual([pick(await autopaymentOf(h, petr, id), 'status'), pick(await autopaymentOf(h, petr, id), 'nextRunOn')], ['ACTIVE', '2026-10-22']);
      assert.deepEqual((await runFacts(id)).map((run) => run.defects), [[]]);
    });
  });

  describe('regression-own-transfer-fee', () => {
    async function ownTransfer(amount: number, key: string) {
      const token = await h.login(PETR);
      const current = await accountOf(h, token, 0);
      const savings = await accountOf(h, token, 1);
      const created = await sendTransfer(h, token, key, { type: 'OWN_TRANSFER', fromAccount: current.number, toAccount: savings.number, amount });
      return { token, current, savings, created };
    }

    it('без сбоя перевод между своими счетами без комиссии, пометки нет', async () => {
      const { created, token, current } = await ownTransfer(30_000_000, 'own-fee-0001');
      assert.deepEqual([pick(created.body, 'status'), pick(created.body, 'fee')], ['COMPLETED', 0]);
      assert.equal((await accountOf(h, token)).balance, current.balance - 30_000_000);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем перевод между своими счетами сверх бесплатного объёма берёт комиссию как перевод в другой банк, с пометкой; проводки сходятся', async () => {
      await setDefects(h, ['regression-own-transfer-fee']);
      const { created, token, current, savings } = await ownTransfer(30_000_000, 'own-fee-0002');
      assert.deepEqual([pick(created.body, 'status'), pick(created.body, 'fee'), pick(created.body, 'total')], ['COMPLETED', 150_000, 30_150_000]);
      assert.deepEqual((await marksOf(h, created)).map((mark) => [mark.code, mark.details.expected, mark.details.actual, mark.details.amount]), [
        ['regression-own-transfer-fee', 0, 150_000, 30_000_000],
      ]);
      assert.equal((await accountOf(h, token, 0)).balance, current.balance - 30_150_000);
      assert.equal((await accountOf(h, token, 1)).balance, savings.balance + 30_000_000);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('со сбоем перевод в пределах бесплатного объёма комиссии не берёт и пометки не получает', async () => {
      await setDefects(h, ['regression-own-transfer-fee']);
      const { created } = await ownTransfer(5_000_000, 'own-fee-0003');
      assert.equal(pick(created.body, 'fee'), 0);
      assert.deepEqual(await marksOf(h, created), []);
    });

    it('со сбоем перевод по телефону внутри банка по-прежнему без комиссии', async () => {
      await setDefects(h, ['regression-own-transfer-fee']);
      const token = await h.login(PETR);
      const from = await accountOf(h, token);
      const created = await settledTransfer(h, token, 'own-fee-0004', phoneTransfer(from.number, ANNA, 13_000_000));
      assert.deepEqual([pick(created.body, 'fee'), pick(created.body, 'status')], [0, 'COMPLETED']);
      assert.equal(await markCount(h), 0);
    });
  });

  it('все четыре дефекта включаются только сценарием, без дефектов в сценарии и после сброса они выключены', async () => {
    const BASE = { label: 'defects:run-1', sbpMode: 'NORMAL', bankTime: null };
    const codes = ['template-skips-limit', 'template-ignores-amount', 'autopay-no-retry', 'regression-own-transfer-fee'];
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: codes, release: '1.1' })).status, 200);
    assert.deepEqual([...(await loadActiveDefects(h.pool))].sort(), [...codes].sort());
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: [], release: '1.1' })).status, 200);
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
    await h.kit('POST', '/_kit/scenario', { ...BASE, defects: codes, release: '1.1' });
    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    assert.equal((await loadActiveDefects(h.pool)).size, 0);
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: ['template-skips-limit', 'нет-такого'], release: '1.1' })).status, 400);
  });
});
