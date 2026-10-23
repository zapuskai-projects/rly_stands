import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadActiveDefects, listDefectMarks } from '../defects/defects.repository';
import { BankError } from '../shared/errors';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, marksOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA } = PHONES;
const BASE = { label: 'task-7:run-1', defects: [], sbpMode: 'NORMAL', bankTime: null };
const ROUTES: [string, string][] = [
  ['POST', '/_kit/scenario'],
  ['POST', '/_kit/reset'],
  ['POST', '/_kit/actions/transfer'],
  ['POST', '/_kit/actions/check-client'],
  ['POST', '/_kit/actions/set-tariff'],
  ['POST', '/_kit/actions/review'],
  ['GET', '/_kit/facts/operations'],
  ['GET', '/_kit/facts/operations/ZB0000100001'],
  ['GET', '/_kit/facts/ledger'],
  ['GET', '/_kit/facts/requests?label=x'],
  ['GET', '/_kit/facts/tariffs/START'],
  ['GET', '/_kit/facts/clock'],
];

describe('служебный API банка: секрет, сценарий, сброс', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const scenario = (body: Record<string, unknown>) => h.kit('POST', '/_kit/scenario', { ...BASE, ...body });

  describe('доступ', () => {
    it('без заголовка и с чужим секретом любой маршрут отвечает 404, как будто его нет', async () => {
      for (const [method, path] of ROUTES) {
        for (const secret of [null, 'wrong', `${KIT_TEST_SECRET}x`, '']) {
          const response = await h.kit(method, path, method === 'POST' ? BASE : undefined, secret);
          assert.equal(response.status, 404, `${method} ${path} с секретом ${String(secret)}`);
          assert.equal(pick(response.body, 'code'), 'NOT_FOUND');
        }
      }
    });

    it('с верным секретом отвечают данные, неизвестный путь внутри _kit — 404', async () => {
      assert.equal((await h.kit('GET', '/_kit/facts/tariffs/START')).status, 200);
      assert.equal((await h.kit('GET', '/_kit/nothing')).status, 404);
      assert.equal((await h.kit('POST', '/_kit/actions/unknown', {})).status, 404);
    });

    it('время банка: сдвинутое помечено сдвигом, после возврата к настоящему — нет', async () => {
      await scenario({ bankTime: '2026-10-23T23:10' });
      const shifted = await h.kit('GET', '/_kit/facts/clock');
      assert.equal(pick(shifted.body, 'shifted'), true);
      assert.match(String(pick(shifted.body, 'now')), /^2026-10-23T20:1/);
      await scenario({ bankTime: null });
      assert.equal(pick((await h.kit('GET', '/_kit/facts/clock')).body, 'shifted'), false);
    });

    it('без KIT_SECRET служебного API нет вовсе, даже с заголовком', async () => {
      await h.close();
      h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
      for (const [method, path] of ROUTES) {
        assert.equal((await h.kit(method, path, method === 'POST' ? BASE : undefined)).status, 404, `${method} ${path}`);
      }
      assert.equal((await h.kit('GET', '/_kit/facts/tariffs/START', undefined, null)).status, 404);
    });

    it('запросы без секрета не попадают в журнал запросов', async () => {
      await h.kit('POST', '/_kit/actions/transfer', { ...BASE, phone: ANNA }, 'wrong');
      assert.equal((await h.pool.query("SELECT 1 FROM request_log WHERE path LIKE '/_kit%'")).rowCount, 0);
    });
  });

  describe('сценарий', () => {
    it('включает сбои, и они срабатывают, повторный сценарий выключает', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      assert.deepEqual((await scenario({ defects: ['limit-boundary'] })).body, { applied: true });
      assert.deepEqual([...(await loadActiveDefects(h.pool))], ['limit-boundary']);
      const rejected = await sendTransfer(h, petr, 'kit-scn-0001', phoneTransfer(from.number, ANNA, 15_000_000));
      assert.equal(pick(rejected.body, 'status'), 'REJECTED');
      assert.deepEqual((await marksOf(h, rejected)).map((mark) => mark.code), ['limit-boundary']);
      await scenario({ defects: [] });
      assert.equal((await loadActiveDefects(h.pool)).size, 0);
      const accepted = await sendTransfer(h, petr, 'kit-scn-0002', phoneTransfer(from.number, ANNA, 15_000_000));
      assert.equal(pick(accepted.body, 'status'), 'CHECKING');
      assert.equal((await marksOf(h, accepted)).length, 0);
    });

    it('сохраняет метку и режим СБП, UNAVAILABLE записывается как недоступность', async () => {
      const read = async () => (await h.pool.query<{ label: string; sbp_mode: string }>('SELECT label, sbp_mode FROM scenario')).rows[0];
      await scenario({ sbpMode: 'TIMEOUT' });
      assert.deepEqual(await read(), { label: 'task-7:run-1', sbp_mode: 'TIMEOUT' });
      await scenario({ label: 'task-9', sbpMode: 'REJECT' });
      assert.deepEqual(await read(), { label: 'task-9', sbp_mode: 'REJECT' });
      await scenario({ sbpMode: 'UNAVAILABLE' });
      assert.equal((await read())?.sbp_mode, 'DOWN');
      await scenario({ sbpMode: 'NORMAL' });
      assert.equal((await read())?.sbp_mode, 'NORMAL');
    });

    it('ставит часы банка на заданное время и идёт от него, null возвращает реальное время', async () => {
      await scenario({ bankTime: '2026-10-21T00:40:00+03:00' });
      assert.equal(h.clock.now().toISOString(), '2026-10-20T21:40:00.000Z');
      const saved = await h.pool.query<{ clock_offset_ms: bigint }>('SELECT clock_offset_ms FROM scenario');
      assert.equal(saved.rows[0]?.clock_offset_ms, BigInt(new Date('2026-10-20T21:40:00Z').getTime() - NOON_MOSCOW.getTime()));
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const created = await sendTransfer(h, petr, 'kit-scn-0003', phoneTransfer(from.number, ANNA, 100_000));
      assert.equal(pick(created.body, 'createdAt'), '2026-10-21T00:40:00.000+03:00');
      h.setTime(new Date(NOON_MOSCOW.getTime() + 60_000));
      assert.equal(h.clock.now().toISOString(), '2026-10-20T21:41:00.000Z');
      await scenario({ bankTime: null });
      assert.equal(h.clock.now().toISOString(), '2026-10-20T09:01:00.000Z');
      assert.equal((await h.pool.query<{ clock_offset_ms: bigint }>('SELECT clock_offset_ms FROM scenario')).rows[0]?.clock_offset_ms, 0n);
    });

    it('правит тарифы и персоны: лимит, квота и комиссия, личный лимит, арест счёта, смена тарифа', async () => {
      const petr = await h.login(PETR);
      const anna = await h.login(ANNA);
      await scenario({
        tariffs: [{ code: 'START', dailyLimitKop: 1_000_000, rateBps: 250 }],
        personas: [{ phone: ANNA, accountStatus: 'ARRESTED' }, { phone: PETR, dailyLimitKop: 600_000 }],
      });
      assert.deepEqual((await h.kit('GET', '/_kit/facts/tariffs/START')).body, {
        code: 'START', name: 'Старт', dailyLimitKop: 1_000_000, freeMonthlyKop: 10_000_000, rateBps: 250, minKop: 3_000, maxKop: 150_000,
      });
      const petrFrom = await accountOf(h, petr);
      const overPersonal = await sendTransfer(h, petr, 'kit-scn-0004', phoneTransfer(petrFrom.number, ANNA, 700_000));
      assert.equal(pick(overPersonal.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
      const annaFrom = await accountOf(h, anna);
      const arrested = await sendTransfer(h, anna, 'kit-scn-0005', phoneTransfer(annaFrom.number, PETR, 100_000));
      assert.equal(pick(arrested.body, 'rejection.code'), 'ACCOUNT_ARRESTED');
      await scenario({ personas: [{ phone: ANNA, accountStatus: 'ACTIVE' }, { phone: PETR, dailyLimitKop: null, tariffCode: 'PENSION' }] });
      assert.equal(pick((await h.api(petr, 'GET', '/api/v1/me')).body, 'tariff.code'), 'PENSION');
      assert.equal(pick((await h.api(petr, 'GET', '/api/v1/me')).body, 'limits.dailyPhoneTransfer.limit'), 5_000_000);
    });

    it('неверное тело — 400 со списком полей, неизвестный тариф и персона — 422, ничего не применяется частично', async () => {
      const invalid = await scenario({ defects: ['limit-boundary', 'нет-такого'], sbpMode: 'DOWN' });
      assert.equal(invalid.status, 400);
      assert.equal(pick(invalid.body, 'code'), 'VALIDATION_ERROR');
      assert.deepEqual((pick(invalid.body, 'details') as { field: string }[]).map((item) => item.field).sort(), ['defects.1', 'sbpMode']);
      const unknownTariff = await scenario({ defects: ['sbp-timeout-stuck'], tariffs: [{ code: 'GOLD', dailyLimitKop: 1 }] });
      assert.equal(unknownTariff.status, 422);
      assert.equal(pick(unknownTariff.body, 'code'), 'UNKNOWN_TARIFF');
      const unknownPersona = await scenario({ defects: ['sbp-timeout-stuck'], personas: [{ phone: '+79990000000', dailyLimitKop: 1 }] });
      assert.equal(pick(unknownPersona.body, 'code'), 'UNKNOWN_PERSONA');
      const inverted = await scenario({ defects: ['sbp-timeout-stuck'], tariffs: [{ code: 'START', minKop: 500_000 }] });
      assert.equal(pick(inverted.body, 'code'), 'INVALID_TARIFF');
      assert.equal((await loadActiveDefects(h.pool)).size, 0);
      assert.equal((await h.pool.query('SELECT label FROM scenario WHERE label IS NOT NULL')).rowCount, 0);
    });
  });

  describe('сброс', () => {
    const snapshot = async () => ({
      accounts: (await h.pool.query('SELECT number, balance_kop FROM accounts ORDER BY number')).rows,
      operations: (await h.pool.query('SELECT number, status, amount_kop, created_at FROM operations ORDER BY number')).rows,
      postings: (await h.pool.query('SELECT amount_kop, kind, posted_at FROM postings ORDER BY id')).rows,
      clients: (await h.pool.query('SELECT number, phone, tariff_code, status FROM clients ORDER BY number')).rows,
    });

    it('возвращает данные к сиду и пустой сценарий: после работы, сдвига часов, правок тарифа и сбоев всё как с нуля', async () => {
      const before = await snapshot();
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      await scenario({ defects: ['limit-boundary', 'kafka-amount-mismatch'], sbpMode: 'TIMEOUT', bankTime: '2026-11-02T02:10:00+03:00', tariffs: [{ code: 'START', dailyLimitKop: 100, rateBps: 9000 }], personas: [{ phone: PETR, dailyLimitKop: 5 }] });
      await sendTransfer(h, petr, 'kit-rst-0001', phoneTransfer(from.number, ANNA, 50));
      await h.drain();
      await h.pool.query('UPDATE antifraud_settings SET review_threshold = 5, reject_threshold = 6');
      assert.notDeepEqual(await snapshot(), before);

      const response = await h.kit('POST', '/_kit/reset');
      assert.deepEqual([response.status, response.body], [200, { reset: true }]);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await h.pool.query('SELECT label, sbp_mode, defects, clock_offset_ms FROM scenario')).rows, [{ label: null, sbp_mode: 'NORMAL', defects: [], clock_offset_ms: 0n }]);
      assert.deepEqual((await h.pool.query('SELECT review_threshold, reject_threshold FROM antifraud_settings')).rows, [{ review_threshold: 70, reject_threshold: 90 }]);
      assert.deepEqual((await h.kit('GET', '/_kit/facts/tariffs/START')).body, {
        code: 'START', name: 'Старт', dailyLimitKop: 15_000_000, freeMonthlyKop: 10_000_000, rateBps: 100, minKop: 3_000, maxKop: 150_000,
      });
      for (const table of ['defect_marks', 'idempotency_keys', 'notifications', 'outbox_events', 'request_log', 'sessions', 'client_limits', 'holds', 'manual_reviews', 'sbp_transfers']) {
        assert.equal((await h.pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0, table);
      }
      assert.equal(h.clock.getOffsetMs(), 0);
      const report = await checkLedger(h.pool);
      assert.deepEqual(report.mismatchedAccounts, []);
      assert.equal(report.totalOfBalances, 0n);
    });

    it('после сброса вызывается очистка топиков, её отказ приходит ответом 502, а не молчанием', async () => {
      const calls: string[] = [];
      let failure: Error | null = null;
      const local = await startHarness(DATABASE_URL as string, NOON_MOSCOW, {
        kitSecret: KIT_TEST_SECRET,
        afterReset: async () => {
          calls.push('cleared');
          if (failure) throw failure;
        },
      });
      try {
        assert.deepEqual([(await local.kit('POST', '/_kit/reset')).status, calls], [200, ['cleared']]);
        failure = new BankError(502, 'TOPICS_NOT_CLEARED', 'Не удалось очистить топики банка');
        const refused = await local.kit('POST', '/_kit/reset');
        assert.deepEqual([refused.status, pick(refused.body, 'code')], [502, 'TOPICS_NOT_CLEARED']);
      } finally {
        await local.close();
      }
    });

    it('после сброса номера операций идут с начала, ключи повтора свободны, вход клиентов и операторов работает, старый токен недействителен', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const first = await sendTransfer(h, petr, 'kit-rst-0002', phoneTransfer(from.number, ANNA, 100_000));
      assert.equal(pick(first.body, 'number'), 'ZB0000100004');
      await h.kit('POST', '/_kit/reset');
      assert.equal((await h.api(petr, 'GET', '/api/v1/me')).status, 401);
      const again = await h.login(PETR);
      const second = await sendTransfer(h, again, 'kit-rst-0002', phoneTransfer((await accountOf(h, again)).number, ANNA, 200_000));
      assert.equal(second.status, 201);
      assert.equal(pick(second.body, 'number'), 'ZB0000100004');
      assert.ok((await h.operatorLogin('senior')).length > 10);
      assert.equal((await listDefectMarks(h.pool, String(pick(second.body, 'id')))).length, 0);
    });
  });
});
