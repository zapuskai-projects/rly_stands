import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KIT_TEST_SECRET, pick, startHarness, type ApiResponse, type Harness } from '../testing/harness';
import { accountOf, NIGHT_MOSCOW, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, setDefects } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA, IP, GALINA } = PHONES;
const OPERATION_KEYS = [
  'ageSeconds', 'amountKop', 'antifraudScore', 'clientPhone', 'clientRemainingKop', 'clientRemainingRub', 'createdAt', 'createdWhileOtherOnReview', 'defectCodes', 'feeKop', 'hasKopecks', 'id',
  'limitAfterKop', 'limitBeforeKop', 'limitBeforeRub', 'limitMarginKop', 'number', 'reasonCode', 'recipientPhone', 'route', 'status', 'statusHistory', 'type', 'wasOnReview',
];

describe('служебный API банка: действия и факты', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const transfer = (body: Record<string, unknown>): Promise<ApiResponse> =>
    h.kit('POST', '/_kit/actions/transfer', { phone: PETR, toPhone: ANNA, amountKop: 150_000, idempotencyKey: 'kit-act-0001', label: 'ref:1', ...body });
  const facts = async (path: string): Promise<unknown> => (await h.kit('GET', `/_kit/facts/${path}`)).body;
  const toBank = { toPhone: '+79005550000', toBankCode: 'KEDR' };

  describe('действия', () => {
    it('перевод от имени клиента: ответ с номером и статусом, метка в операции и в журнале запросов', async () => {
      const response = await transfer({});
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body as object).sort(), ['number', 'operationId', 'status']);
      assert.equal(pick(response.body, 'status'), 'CHECKING');
      assert.match(String(pick(response.body, 'number')), /^ZB\d{10}$/);
      const operation = await h.pool.query('SELECT attempt_label FROM operations WHERE id = $1', [pick(response.body, 'operationId')]);
      assert.equal(operation.rows[0]?.attempt_label, 'ref:1');
      const log = (await facts('requests?label=ref%3A1')) as Record<string, unknown>[];
      assert.deepEqual(
        log.map((row) => [row.method, row.path, row.status, row.responseStatus, row.errorCode, row.operationId, row.replayed, row.idempotencyKey]),
        [['POST', '/_kit/actions/transfer', 200, 200, null, pick(response.body, 'operationId'), false, 'kit-act-0001']],
      );
    });

    it('повтор с тем же ключом возвращает ту же операцию, перевод между своими счетами проводится сразу, в другой банк идёт по СБП', async () => {
      const first = await transfer({});
      const second = await transfer({});
      assert.equal(pick(second.body, 'operationId'), pick(first.body, 'operationId'));
      const petr = await h.login(PETR);
      const accounts = (await h.api(petr, 'GET', '/api/v1/accounts')).body as { items: { number: string; kind: string }[] };
      const savings = accounts.items.find((item) => item.kind !== 'CURRENT');
      if (savings) {
        const own = await h.kit('POST', '/_kit/actions/transfer', { phone: PETR, toOwnAccount: savings.number, amountKop: 5_000, idempotencyKey: 'kit-act-0002', label: 'ref:1' });
        assert.equal(pick(own.body, 'status'), 'COMPLETED');
      }
      const external = await transfer({ ...toBank, idempotencyKey: 'kit-act-0003' });
      await h.drain();
      const done = await facts(`operations/${String(pick(external.body, 'number'))}`);
      assert.equal(pick(done, 'route'), 'SBP');
      assert.equal(pick(done, 'status'), 'COMPLETED');
    });

    it('ошибки действия: нет клиента — 404, оба или ни одного получателя — 400, не хватает денег — 422', async () => {
      assert.equal((await transfer({ phone: '+79990000000' })).status, 404);
      assert.equal((await transfer({ toOwnAccount: '40817810800000001001' })).status, 400);
      assert.equal((await transfer({ toPhone: undefined })).status, 400);
      const poor = await transfer({ phone: ANNA, toPhone: PETR, amountKop: 14_000_000, idempotencyKey: 'kit-act-0004' });
      assert.equal(poor.status, 422);
      assert.equal(pick(poor.body, 'code'), 'INSUFFICIENT_FUNDS');
    });

    it('смена тарифа и решение оператора для эталона', async () => {
      const tariff = await h.kit('POST', '/_kit/actions/set-tariff', { code: 'PENSION', dailyLimitKop: 7_000_000, minKop: 1_000 });
      assert.deepEqual(tariff.body, { code: 'PENSION', name: 'Пенсионный', dailyLimitKop: 7_000_000, freeMonthlyKop: 10_000_000, rateBps: 100, minKop: 1_000, maxKop: 150_000 });
      assert.deepEqual(await facts('tariffs/PENSION'), tariff.body);
      assert.equal((await h.kit('POST', '/_kit/actions/set-tariff', { code: 'GOLD', rateBps: 1 })).status, 422);
      assert.equal((await h.kit('POST', '/_kit/actions/set-tariff', { code: 'START', minKop: 999_999_999 })).status, 422);

      h.setTime(NIGHT_MOSCOW);
      const held = await h.kit('POST', '/_kit/actions/transfer', { phone: ANNA, toPhone: PETR, amountKop: 1_500_000, idempotencyKey: 'kit-act-0005', label: 'ref:2' });
      await h.drain();
      assert.equal(pick(await facts(`operations/${String(pick(held.body, 'number'))}`), 'status'), 'ON_REVIEW');
      const approved = await h.kit('POST', '/_kit/actions/review', { operationId: pick(held.body, 'operationId'), decision: 'APPROVE', comment: 'Подтверждено' });
      assert.equal(approved.status, 200);
      assert.equal(pick(approved.body, 'state'), 'APPROVED');
      await h.drain();
      assert.equal(pick(await facts(`operations/${String(pick(held.body, 'number'))}`), 'status'), 'COMPLETED');
      const again = await h.kit('POST', '/_kit/actions/review', { operationId: pick(held.body, 'operationId'), decision: 'REJECT' });
      assert.equal(again.status, 409);
      assert.equal(pick(again.body, 'code'), 'REVIEW_ALREADY_RESOLVED');

      const second = await h.kit('POST', '/_kit/actions/transfer', { phone: IP, toPhone: GALINA, amountKop: 1_500_000, idempotencyKey: 'kit-act-0006', label: 'ref:2' });
      await h.drain();
      const rejected = await h.kit('POST', '/_kit/actions/review', { operationId: pick(second.body, 'operationId'), decision: 'REJECT' });
      assert.equal(pick(rejected.body, 'state'), 'REJECTED');
      assert.equal(pick(rejected.body, 'status'), 'REJECTED');
      assert.equal((await h.kit('POST', '/_kit/actions/review', { operationId: '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10', decision: 'APPROVE' })).status, 404);
    });
  });

  describe('факты об операциях', () => {
    it('список по метке, телефону и статусу: поля договора, история по порядку, причина отказа', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const student = await sendTransfer(h, petr, 'kit-fct-0001', phoneTransfer(from.number, ANNA, 15_000_001), { 'X-Attempt-Label': 'student:1' });
      await transfer({ label: 'ref:3' });
      await h.drain();
      const byStudent = (await facts('operations?label=student%3A1')) as Record<string, unknown>[];
      assert.equal(byStudent.length, 1);
      assert.deepEqual(Object.keys(byStudent[0] as object).sort(), OPERATION_KEYS);
      assert.equal(byStudent[0]?.id, pick(student.body, 'id'));
      assert.equal(byStudent[0]?.status, 'REJECTED');
      assert.equal(byStudent[0]?.reasonCode, 'DAILY_LIMIT_EXCEEDED');
      assert.equal(byStudent[0]?.amountKop, 15_000_001);
      assert.equal(byStudent[0]?.hasKopecks, true);
      assert.equal(typeof byStudent[0]?.ageSeconds, 'number');
      assert.ok((byStudent[0]?.ageSeconds as number) >= 0);
      assert.equal(byStudent[0]?.clientPhone, PETR);
      assert.equal(byStudent[0]?.recipientPhone, ANNA);
      assert.equal(byStudent[0]?.antifraudScore, null);
      assert.deepEqual(byStudent[0]?.defectCodes, []);
      assert.equal(byStudent[0]?.createdAt, '2026-10-20T12:00:00.000+03:00');
      assert.deepEqual((byStudent[0]?.statusHistory as { status: string }[]).map((step) => step.status), ['CREATED', 'CHECKING', 'REJECTED']);
      assert.deepEqual(Object.keys((byStudent[0]?.statusHistory as object[])[0] as object).sort(), ['at', 'reasonCode', 'status']);

      const reference = (await facts('operations?label=ref%3A3')) as { status: string; feeKop: number; route: string }[];
      assert.deepEqual(reference.map((item) => [item.status, item.feeKop, item.route]), [['COMPLETED', 0, 'INTERNAL']]);
      assert.equal(((await facts(`operations?phone=${encodeURIComponent(PETR)}`)) as unknown[]).length, 2);
      assert.equal(((await facts(`operations?phone=${PETR}&status=COMPLETED`)) as unknown[]).length, 1);
      assert.equal(((await facts('operations?status=REJECTED')) as unknown[]).length, 1);
      assert.equal(((await facts('operations?label=nobody')) as unknown[]).length, 0);
      assert.equal((await h.kit('GET', '/_kit/facts/operations?status=DONE')).status, 400);
    });

    it('операция по метке находится и по запросу чтения с этой меткой', async () => {
      const petr = await h.login(PETR);
      const created = await sendTransfer(h, petr, 'kit-fct-0002', phoneTransfer((await accountOf(h, petr)).number, ANNA, 100_000));
      await h.api(petr, 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`, undefined, { 'X-Attempt-Label': 'reader:1' });
      const found = (await facts('operations?label=reader%3A1')) as { id: string }[];
      assert.deepEqual(found.map((item) => item.id), [pick(created.body, 'id')]);
    });

    it('причина неудачи и возврата берётся из истории статусов', async () => {
      h.sbp.mode = 'REJECTED';
      const failed = await transfer({ phone: IP, ...toBank, idempotencyKey: 'kit-fct-0003' });
      await h.drain();
      h.sbp.mode = 'TIMEOUT';
      const refunded = await transfer({ phone: IP, ...toBank, idempotencyKey: 'kit-fct-0004' });
      await h.drain();
      assert.equal(pick(await facts(`operations/${String(pick(failed.body, 'number'))}`), 'reasonCode'), 'SBP_REJECTED');
      assert.equal(pick(await facts(`operations/${String(pick(refunded.body, 'operationId'))}`), 'reasonCode'), 'SBP_TIMEOUT');
    });

    it('одна операция по номеру и по идентификатору: проводки, антифрод, уведомления, сработавшие сбои', async () => {
      await setDefects(h, ['notify-before-complete']);
      const own = await transfer({ phone: IP, ...toBank, amountKop: 100_000, idempotencyKey: 'kit-fct-0005', label: 'ref:4' });
      await h.drain({ sbp: false });
      const early = (await facts(`operations/${String(pick(own.body, 'number'))}`)) as Record<string, unknown>;
      assert.equal(early.status, 'PROCESSING');
      assert.deepEqual((early.defects as { code: string }[]).map((item) => item.code), ['notify-before-complete']);
      assert.deepEqual(early.postings, []);
      const listed = ((await facts('operations?label=ref%3A4')) as { antifraudScore: number | null; defectCodes: string[] }[])[0];
      assert.equal(typeof listed?.antifraudScore, 'number');
      assert.deepEqual(listed?.defectCodes, ['notify-before-complete']);
      assert.deepEqual((early.notifications as { channel: string; beforeCompletion: boolean }[]).map((item) => [item.channel, item.beforeCompletion]).sort(), [['PUSH', true], ['SMS', true]]);
      h.setTime(new Date(NOON_MOSCOW.getTime() + 3000));
      await h.drain();
      const done = (await facts(`operations/${String(pick(own.body, 'operationId'))}`)) as Record<string, unknown>;
      assert.equal(done.status, 'COMPLETED');
      assert.deepEqual((done.notifications as { beforeCompletion: boolean }[]).map((item) => item.beforeCompletion), [true, true]);
      const kinds = (done.postings as { kind: string; amountKop: number; debit: string; credit: string }[]).map((item) => [item.kind, item.amountKop]);
      assert.deepEqual(kinds, [['TRANSFER', 100_000]]);
      assert.match(String((done.postings as { debit: string }[])[0]?.debit), /^\d{20}$/);

      await setDefects(h, []);
      const plain = await h.kit('POST', '/_kit/actions/transfer', { phone: PETR, toPhone: ANNA, amountKop: 150_000, idempotencyKey: 'kit-fct-0006', label: 'ref:4' });
      await h.drain();
      const full = (await facts(`operations/${String(pick(plain.body, 'number'))}`)) as Record<string, unknown>;
      assert.deepEqual(full.defects, []);
      assert.deepEqual((full.notifications as { beforeCompletion: boolean }[]).map((item) => item.beforeCompletion), [false, false, false, false]);
      assert.equal(pick(full, 'antifraud.score'), 47);
      assert.deepEqual((pick(full, 'antifraud.rules') as { code: string }[]).map((rule) => rule.code), ['NEW_RECIPIENT', 'AMOUNT_ABOVE_USUAL']);
      assert.equal((await h.kit('GET', '/_kit/facts/operations/ZB9999999999')).status, 404);
    });

    it('операция без решения антифрода — антифрод null', async () => {
      const petr = await h.login(PETR);
      const savings = ((await h.api(petr, 'GET', '/api/v1/accounts')).body as { items: { number: string; kind: string }[] }).items.find((item) => item.kind !== 'CURRENT');
      const created = await h.kit('POST', '/_kit/actions/transfer', savings
        ? { phone: PETR, toOwnAccount: savings.number, amountKop: 100, idempotencyKey: 'kit-fct-0007', label: 'ref:5' }
        : { phone: PETR, toPhone: ANNA, amountKop: 100, idempotencyKey: 'kit-fct-0007', label: 'ref:5' });
      const fact = await facts(`operations/${String(pick(created.body, 'number'))}`);
      assert.equal(pick(fact, 'antifraud'), savings ? null : pick(fact, 'antifraud'));
    });
  });

  describe('факты о проводках, запросах и тарифах', () => {
    it('остаток счёта сходится с проводками, холд виден, сбитый остаток находится', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      assert.deepEqual(await facts(`ledger?account=${from.number}`), { account: from.number, balanceKop: from.balance, postingsSumKop: from.balance, consistent: true, holdsKop: 0 });
      await transfer({});
      assert.equal(pick(await facts(`ledger?account=${from.number}`), 'holdsKop'), 150_000);
      assert.deepEqual(await facts('ledger'), { inconsistent: [] });
      await h.pool.query('UPDATE accounts SET balance_kop = balance_kop + 7 WHERE number = $1', [from.number]);
      const broken = (await facts(`ledger?account=${from.number}`)) as Record<string, unknown>;
      assert.equal(broken.consistent, false);
      assert.equal((broken.balanceKop as number) - (broken.postingsSumKop as number), 7);
      assert.deepEqual(await facts('ledger'), { inconsistent: [{ account: from.number, balanceKop: from.balance + 7, postingsSumKop: from.balance }] });
      assert.equal((await h.kit('GET', '/_kit/facts/ledger?account=40817810800000009999')).status, 404);
      assert.equal((await h.kit('GET', '/_kit/facts/ledger?account=1')).status, 400);
    });

    it('журнал запросов по метке: ответ, код ошибки, операция, повтор, ключ и время банка; метка обязательна', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const label = { 'X-Attempt-Label': 'student:9' };
      const send = (key: string, body: unknown, headers: Record<string, string> = label) => sendTransfer(h, petr, key, body, headers);
      const first = await send('kit-fct-0008', phoneTransfer(from.number, ANNA, 100_000));
      await send('kit-fct-0008', phoneTransfer(from.number, ANNA, 100_000));
      await send('kit-fct-0009', phoneTransfer(from.number, '+7900', 100_000));
      const limited = await send('kit-fct-0010', phoneTransfer(from.number, ANNA, 15_000_000));
      const anna = await h.login(ANNA);
      await sendTransfer(h, anna, 'kit-fct-0011', phoneTransfer((await accountOf(h, anna)).number, PETR, 14_000_000), label);
      await h.api(petr, 'GET', `/api/v1/operations/${String(pick(first.body, 'id'))}`, undefined, label);
      await h.api(null, 'GET', '/api/v1/accounts', undefined, label);
      await h.api(petr, 'GET', '/api/v1/accounts');
      const rows = (await facts('requests?label=student%3A9')) as Record<string, unknown>[];
      assert.deepEqual(
        rows.map((row) => [row.method, row.path, row.responseStatus, row.errorCode, row.operationId, row.replayed, row.idempotencyKey]),
        [
          ['POST', '/api/v1/transfers', 201, null, pick(first.body, 'id'), false, 'kit-fct-0008'],
          ['POST', '/api/v1/transfers', 200, null, pick(first.body, 'id'), true, 'kit-fct-0008'],
          ['POST', '/api/v1/transfers', 400, 'VALIDATION_ERROR', null, false, 'kit-fct-0009'],
          ['POST', '/api/v1/transfers', 201, 'DAILY_LIMIT_EXCEEDED', pick(limited.body, 'id'), false, 'kit-fct-0010'],
          ['POST', '/api/v1/transfers', 422, 'INSUFFICIENT_FUNDS', null, false, 'kit-fct-0011'],
          ['GET', `/api/v1/operations/${String(pick(first.body, 'id'))}`, 200, null, pick(first.body, 'id'), false, null],
          ['GET', '/api/v1/accounts', 401, 'UNAUTHORIZED', null, false, null],
        ],
      );
      assert.ok(rows.every((row) => row.status === row.responseStatus));
      assert.deepEqual(Object.keys(rows[0] as object).sort(), ['at', 'errorCode', 'idempotencyKey', 'method', 'operationId', 'operationTerminalAt', 'path', 'replayed', 'responseStatus', 'status']);
      assert.equal(rows[0]?.at, '2026-10-20T12:00:00.000+03:00');
      assert.equal((await h.kit('GET', '/_kit/facts/requests')).status, 400);
      assert.deepEqual(await facts('requests?label=nobody'), []);
    });

    it('опрос операции: запрос видит время конечного статуса операции, у операции в работе его нет', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const label = { 'X-Attempt-Label': 'student:poll' };
      const created = await sendTransfer(h, petr, 'kit-fct-0020', phoneTransfer(from.number, ANNA, 100_000), label);
      const id = String(pick(created.body, 'id'));
      await h.api(petr, 'GET', `/api/v1/operations/${id}`, undefined, label);
      await h.drain();
      await h.api(petr, 'GET', `/api/v1/operations/${id}`, undefined, label);
      const rows = (await facts('requests?label=student%3Apoll')) as Record<string, unknown>[];
      assert.deepEqual(rows.map((row) => row.method), ['POST', 'GET', 'GET']);
      assert.ok(rows.every((row) => typeof row.operationTerminalAt === 'string'));
      const finished = (await facts(`operations/${id}`)) as { statusHistory: { status: string; at: string }[] };
      assert.equal(rows[2]?.operationTerminalAt, finished.statusHistory.at(-1)?.at);
    });

    it('перевод на проверке держит лимит: следующий отклонён, пока первый ждёт; остаток до и после, запас и флаги операции', async () => {
      h.setTime(NIGHT_MOSCOW);
      const first = await transfer({ phone: ANNA, toPhone: PETR, amountKop: 1_500_000, idempotencyKey: 'kit-act-0101', label: 'trace:1' });
      await h.drain();
      const second = await transfer({ phone: ANNA, toPhone: PETR, amountKop: 14_000_000, idempotencyKey: 'kit-act-0102', label: 'trace:1' });
      await h.drain();
      const byNumber = async (response: ApiResponse) => (await facts(`operations/${String(pick(response.body, 'number'))}`)) as Record<string, unknown>;
      const one = await byNumber(first);
      const two = await byNumber(second);
      assert.deepEqual(
        [one.status, one.wasOnReview, one.createdWhileOtherOnReview, one.limitBeforeKop, one.limitAfterKop, one.limitMarginKop, one.limitBeforeRub],
        ['ON_REVIEW', true, false, 15_000_000, 13_500_000, 13_500_000, 150_000],
      );
      assert.deepEqual(
        [two.status, two.reasonCode, two.wasOnReview, two.createdWhileOtherOnReview, two.limitBeforeKop, two.limitAfterKop, two.limitMarginKop, two.limitBeforeRub],
        ['REJECTED', 'DAILY_LIMIT_EXCEEDED', false, true, 13_500_000, 13_500_000, -500_000, 135_000],
      );
      assert.deepEqual([one.clientRemainingKop, two.clientRemainingKop, two.clientRemainingRub], [13_500_000, 13_500_000, 135_000]);
    });

    it('граничные суммы: перевод ровно на остаток оставляет ноль, у перевода не по телефону лимита нет', async () => {
      const exact = await transfer({ phone: GALINA, toPhone: PETR, amountKop: 5_000_000, idempotencyKey: 'kit-act-0103', label: 'trace:2' });
      await h.drain();
      const fact = (await facts(`operations/${String(pick(exact.body, 'number'))}`)) as Record<string, unknown>;
      assert.deepEqual([fact.status, fact.limitBeforeKop, fact.limitAfterKop, fact.limitMarginKop], ['COMPLETED', 5_000_000, 0, 0]);
      assert.equal(fact.clientRemainingKop, 0);
      const petr = await h.login(PETR);
      const savings = (await h.api(petr, 'GET', '/api/v1/accounts')).body as { items: { number: string; kind: string }[] };
      const target = savings.items.find((item) => item.kind !== 'CURRENT');
      if (!target) return;
      const own = await transfer({ toPhone: undefined, toOwnAccount: target.number, amountKop: 5_000, idempotencyKey: 'kit-act-0104', label: 'trace:2' });
      const ownFact = (await facts(`operations/${String(pick(own.body, 'number'))}`)) as Record<string, unknown>;
      assert.deepEqual([ownFact.limitBeforeKop, ownFact.limitAfterKop, ownFact.limitMarginKop, ownFact.limitBeforeRub], [null, null, null, null]);
    });

    it('действия перевода пишут в журнал отказ, повтор и ошибку так же, как публичный API', async () => {
      await transfer({ label: 'ref:7' });
      await transfer({ label: 'ref:7' });
      await transfer({ label: 'ref:7', amountKop: 15_000_001, idempotencyKey: 'kit-act-0010' });
      await transfer({ label: 'ref:7', phone: ANNA, toPhone: PETR, amountKop: 14_000_000, idempotencyKey: 'kit-act-0011' });
      await transfer({ label: 'ref:7', phone: '+79990000000', idempotencyKey: 'kit-act-0012' });
      const rows = (await facts('requests?label=ref%3A7')) as Record<string, unknown>[];
      assert.deepEqual(
        rows.map((row) => [row.path, row.responseStatus, row.errorCode, row.operationId === null, row.replayed, row.idempotencyKey]),
        [
          ['/_kit/actions/transfer', 200, null, false, false, 'kit-act-0001'],
          ['/_kit/actions/transfer', 200, null, false, true, 'kit-act-0001'],
          ['/_kit/actions/transfer', 200, 'DAILY_LIMIT_EXCEEDED', false, false, 'kit-act-0010'],
          ['/_kit/actions/transfer', 422, 'INSUFFICIENT_FUNDS', true, false, 'kit-act-0011'],
          ['/_kit/actions/transfer', 404, 'CLIENT_NOT_FOUND', true, false, 'kit-act-0012'],
        ],
      );
      assert.equal(rows[0]?.operationId, rows[1]?.operationId);
    });

    it('настройки тарифа по коду, неизвестный тариф — 404', async () => {
      assert.deepEqual(await facts('tariffs/START'), { code: 'START', name: 'Старт', dailyLimitKop: 15_000_000, freeMonthlyKop: 10_000_000, rateBps: 100, minKop: 3_000, maxKop: 150_000 });
      assert.equal(pick(await facts('tariffs/PENSION'), 'dailyLimitKop'), 5_000_000);
      assert.equal((await h.kit('GET', '/_kit/facts/tariffs/GOLD')).status, 404);
    });
  });
});
