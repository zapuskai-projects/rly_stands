import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadAsyncApi } from '../testing/asyncapi';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, markCount, marksOf, NEW_OPERATIONS, NIGHT_MOSCOW, NOON_MOSCOW, operationOf, PHONES, phoneTransfer, sendTransfer, setDefects } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA, IP } = PHONES;

describe('сбои повтора, СБП, уведомлений и событий, включаемые сценарием', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  const toBank = (from: string, amount: number) => phoneTransfer(from, '+79005550000', amount, { recipientBankCode: 'KEDR' });
  const notificationsOf = (operationId: string) =>
    h.pool.query<{ created_at: Date }>('SELECT created_at FROM notifications WHERE operation_id = $1 ORDER BY id', [operationId]);
  const completedAt = async (operationId: string) =>
    (await h.pool.query<{ completed_at: Date | null }>('SELECT completed_at FROM operations WHERE id = $1', [operationId])).rows[0]?.completed_at ?? null;

  describe('idempotency-double-debit', () => {
    async function repeated(key = 'idem-key-0001') {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const body = phoneTransfer(from.number, ANNA, 150_000);
      const first = await sendTransfer(h, petr, key, body);
      const second = await sendTransfer(h, petr, key, body);
      return { petr, from, body, first, second };
    }

    it('без сбоя повтор с тем же ключом возвращает ту же операцию, списание одно, пометок нет', async () => {
      const { petr, from, first, second } = await repeated();
      assert.equal(second.status, 200);
      assert.equal(pick(second.body, 'id'), pick(first.body, 'id'));
      assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
      assert.equal((await accountOf(h, petr)).held, 150_000);
      await h.drain();
      assert.equal((await accountOf(h, petr)).balance, from.balance - 150_000);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем повтор, пока первый перевод в обработке, создаёт вторую операцию и второе списание', async () => {
      await setDefects(h, ['idempotency-double-debit']);
      const { petr, from, first, second } = await repeated();
      assert.equal(second.status, 201);
      assert.notEqual(pick(second.body, 'id'), pick(first.body, 'id'));
      assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 2);
      assert.equal((await accountOf(h, petr)).held, 300_000);
      await h.drain();
      assert.equal(pick((await operationOf(h, petr, first)).body, 'status'), 'COMPLETED');
      assert.equal(pick((await operationOf(h, petr, second)).body, 'status'), 'COMPLETED');
      assert.equal((await accountOf(h, petr)).balance, from.balance - 300_000);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
      assert.deepEqual(await marksOf(h, first), []);
      const marks = await marksOf(h, second);
      assert.deepEqual(marks.map((mark) => mark.code), ['idempotency-double-debit']);
      assert.deepEqual(marks[0]?.details, {
        expected: pick(first.body, 'number'),
        actual: pick(second.body, 'number'),
        idempotencyKey: 'idem-key-0001',
        firstOperationId: pick(first.body, 'id'),
        firstStatus: 'CHECKING',
      });
    });

    it('со сбоем повтор после завершения первого перевода возвращает его же, пометок нет', async () => {
      await setDefects(h, ['idempotency-double-debit']);
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const body = phoneTransfer(from.number, ANNA, 150_000);
      const first = await sendTransfer(h, petr, 'idem-key-0002', body);
      await h.drain();
      const second = await sendTransfer(h, petr, 'idem-key-0002', body);
      assert.equal(second.status, 200);
      assert.equal(pick(second.body, 'id'), pick(first.body, 'id'));
      assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем тот же ключ с другим телом по-прежнему отклоняется', async () => {
      await setDefects(h, ['idempotency-double-debit']);
      const { petr, from } = await repeated('idem-key-0003');
      const other = await sendTransfer(h, petr, 'idem-key-0003', phoneTransfer(from.number, ANNA, 150_001));
      assert.equal(other.status, 422);
      assert.equal(pick(other.body, 'code'), 'IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('sbp-timeout-stuck', () => {
    async function timedOutTransfer() {
      h.sbp.mode = 'TIMEOUT';
      const ip = await h.login(IP);
      const from = await accountOf(h, ip);
      const created = await sendTransfer(h, ip, 'stuck-key-0001', toBank(from.number, 500_000));
      await h.drain();
      return { ip, from, created };
    }

    it('без сбоя тайм-аут СБП заканчивается возвратом, пометок нет', async () => {
      const { ip, from, created } = await timedOutTransfer();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'REFUNDED');
      assert.equal((await accountOf(h, ip)).available, from.balance);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем операция остаётся в PROCESSING, холд не снят, возврата и проводок нет', async () => {
      await setDefects(h, ['sbp-timeout-stuck']);
      const { ip, from, created } = await timedOutTransfer();
      const stuck = await operationOf(h, ip, created);
      assert.equal(pick(stuck.body, 'status'), 'PROCESSING');
      assert.deepEqual((pick(stuck.body, 'statusHistory') as { status: string }[]).map((item) => item.status), ['CREATED', 'CHECKING', 'PROCESSING']);
      const account = await accountOf(h, ip);
      assert.deepEqual([account.balance, account.held, account.available], [from.balance, 500_000, from.balance - 500_000]);
      assert.equal((await h.pool.query('SELECT 1 FROM postings WHERE operation_id = $1', [pick(created.body, 'id')])).rowCount, 0);
      assert.equal(await h.recoverSbp(0), 0);
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'PROCESSING');
      assert.equal(h.events.some((event) => (event.payload as { status?: string }).status === 'REFUNDED'), false);
      const marks = await marksOf(h, created);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details]), [['sbp-timeout-stuck', { expected: 'REFUNDED', actual: 'PROCESSING', held: 500_000 }]]);
    });

    it('со сбоем отправка, оборванная перезапуском, тоже остаётся в PROCESSING и помечена', async () => {
      await setDefects(h, ['sbp-timeout-stuck']);
      const ip = await h.login(IP);
      const from = await accountOf(h, ip);
      const created = await sendTransfer(h, ip, 'stuck-key-0002', toBank(from.number, 500_000));
      await h.drain({ sbp: false });
      await h.pool.query("UPDATE sbp_transfers SET state = 'SENT', dispatched_at = now() - interval '1 minute'");
      assert.equal(await h.recoverSbp(10_000), 1);
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'PROCESSING');
      assert.deepEqual((await marksOf(h, created)).map((mark) => mark.code), ['sbp-timeout-stuck']);
    });

    it('со сбоем ответ банка получателя обрабатывается как обычно и пометок нет', async () => {
      await setDefects(h, ['sbp-timeout-stuck']);
      const ip = await h.login(IP);
      const from = await accountOf(h, ip);
      const created = await sendTransfer(h, ip, 'stuck-key-0003', toBank(from.number, 500_000));
      await h.drain();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'COMPLETED');
      assert.equal(await markCount(h), 0);
    });
  });

  describe('notify-before-complete', () => {
    async function sendWithoutSbpAnswer(amount = 100_000) {
      const ip = await h.login(IP);
      const from = await accountOf(h, ip);
      const created = await sendTransfer(h, ip, 'notify-key-0001', toBank(from.number, amount));
      await h.drain({ sbp: false });
      return { ip, created, id: String(pick(created.body, 'id')) };
    }

    it('без сбоя СМС и пуш приходят только после проведения, пометок нет', async () => {
      const { ip, created, id } = await sendWithoutSbpAnswer();
      assert.equal((await notificationsOf(id)).rowCount, 0);
      h.setTime(new Date(NOON_MOSCOW.getTime() + 3000));
      await h.drain();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'COMPLETED');
      const notifications = await notificationsOf(id);
      assert.equal(notifications.rowCount, 2);
      assert.ok((notifications.rows[0]?.created_at ?? 0) >= ((await completedAt(id)) as Date));
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем СМС и пуш уходят, пока перевод ещё в обработке, и не дублируются после проведения', async () => {
      await setDefects(h, ['notify-before-complete']);
      const { ip, created, id } = await sendWithoutSbpAnswer();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'PROCESSING');
      assert.equal((await notificationsOf(id)).rowCount, 2);
      const sentAt = (await notificationsOf(id)).rows[0]?.created_at as Date;
      h.setTime(new Date(NOON_MOSCOW.getTime() + 3000));
      await h.drain();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'COMPLETED');
      assert.equal((await notificationsOf(id)).rowCount, 2);
      assert.ok(sentAt < ((await completedAt(id)) as Date));
      const marks = await marksOf(h, created);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details]), [['notify-before-complete', { expected: 'COMPLETED', actual: 'PROCESSING' }]]);
    });

    it('со сбоем отказ банка получателя после СМС оставляет клиента с уведомлением о неисполненном переводе', async () => {
      await setDefects(h, ['notify-before-complete']);
      const { ip, created, id } = await sendWithoutSbpAnswer();
      h.sbp.mode = 'REJECTED';
      await h.drain();
      assert.equal(pick((await operationOf(h, ip, created)).body, 'status'), 'FAILED');
      assert.equal((await notificationsOf(id)).rowCount, 2);
    });

    it('со сбоем внутренний перевод проводится сразу, уведомления как обычно и без пометок', async () => {
      await setDefects(h, ['notify-before-complete']);
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const created = await sendTransfer(h, petr, 'notify-key-0002', phoneTransfer(from.number, ANNA, 150_000));
      await h.drain();
      assert.equal((await notificationsOf(String(pick(created.body, 'id')))).rowCount, 4);
      assert.equal(await markCount(h), 0);
    });
  });

  describe('kafka-amount-mismatch', () => {
    const createdEvents = () => h.events.filter((event) => event.topic === 'bank.payments.created');

    async function annaSends(amount: number, key = 'kafka-key-0001') {
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      const created = await sendTransfer(h, anna, key, phoneTransfer(from.number, PETR, amount));
      await h.drain();
      return { anna, created };
    }

    it('без сбоя сумма в событии в копейках и событие проходит сверку с AsyncAPI, пометок нет', async () => {
      await annaSends(150_050);
      assert.equal((createdEvents()[0]?.payload as { amount: number }).amount, 150_050);
      assert.equal(loadAsyncApi().payloadValidator('bank.payments.created')(createdEvents()[0]?.payload).ok, true);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем сумма в событии в рублях с дробью, контракт нарушен, а операция и проводки верные', async () => {
      await setDefects(h, ['kafka-amount-mismatch']);
      const { anna, created } = await annaSends(150_050);
      const payload = createdEvents()[0]?.payload as { amount: number; fee: number };
      assert.equal(payload.amount, 1500.5);
      assert.equal(payload.fee, 0);
      const verdict = loadAsyncApi().payloadValidator('bank.payments.created')(payload);
      assert.equal(verdict.ok, false);
      assert.match(verdict.issues.join(';'), /amount/);
      const operation = await operationOf(h, anna, created);
      assert.equal(pick(operation.body, 'status'), 'COMPLETED');
      assert.equal(pick(operation.body, 'amount'), 150_050);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
      const marks = await marksOf(h, created);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details]), [['kafka-amount-mismatch', { topic: 'bank.payments.created', expected: 150_050, actual: 1500.5 }]]);
    });

    it('со сбоем целое число рублей проходит проверку типа, но всё равно помечено', async () => {
      await setDefects(h, ['kafka-amount-mismatch']);
      const { created } = await annaSends(150_000);
      assert.equal((createdEvents()[0]?.payload as { amount: number }).amount, 1500);
      assert.deepEqual((await marksOf(h, created)).map((mark) => mark.details.actual), [1500]);
    });

    it('со сбоем антифрод оценивает перевод по настоящей сумме операции', async () => {
      await setDefects(h, ['kafka-amount-mismatch']);
      h.setTime(NIGHT_MOSCOW);
      const { anna, created } = await annaSends(1_500_000);
      assert.equal(pick((await operationOf(h, anna, created)).body, 'status'), 'ON_REVIEW');
      const decision = h.events.find((event) => event.topic === 'bank.antifraud.decisions')?.payload as { score: number };
      assert.equal(decision.score, 72);
    });
  });

  describe('events.duplicate-delivery', () => {
    const idsOn = (topic: string) => h.events.filter((event) => event.topic === topic).map((event) => (event.payload as { eventId: string }).eventId);
    const repeated = (ids: string[]) => ids.filter((id, index) => ids.indexOf(id) !== index);
    const digit = (number: unknown) => Number(String(number).slice(-1));

    async function threeTransfers() {
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      const created = [];
      for (const key of ['dup-key-0001', 'dup-key-0002', 'dup-key-0003']) created.push(await sendTransfer(h, anna, key, phoneTransfer(from.number, PETR, 100_000)));
      await h.drain();
      return { anna, created };
    }

    it('без сбоя ни одно событие не приходит дважды, пометок нет', async () => {
      await threeTransfers();
      assert.deepEqual(repeated(idsOn('bank.payments.created')), []);
      assert.deepEqual(repeated(idsOn('bank.payments.status-changed')), []);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем события операций с нечётным номером приходят дважды с тем же eventId, остальные один раз', async () => {
      await setDefects(h, ['events.duplicate-delivery']);
      const { created } = await threeTransfers();
      const odd = created.filter((item) => digit(pick(item.body, 'number')) % 2 === 1);
      assert.ok(odd.length >= 1 && odd.length < 3);
      const createdFor = (id: unknown) => h.events.filter((event) => event.topic === 'bank.payments.created' && event.headers.operationId === id);
      for (const item of created) {
        const expected = odd.includes(item) ? 2 : 1;
        assert.equal(createdFor(pick(item.body, 'id')).length, expected);
      }
      const doubled = repeated(idsOn('bank.payments.created'));
      assert.equal(doubled.length, odd.length);
      const statusEvents = h.events.filter((event) => event.topic === 'bank.payments.status-changed' && event.headers.operationId === pick(odd[0]?.body, 'id'));
      assert.equal(statusEvents.length, 6);
      assert.equal(repeated(statusEvents.map((event) => (event.payload as { eventId: string }).eventId)).length, 3);
    });

    it('операции и проводки не затронуты, помечены только повторённые операции, пометка называет топик и событие', async () => {
      await setDefects(h, ['events.duplicate-delivery']);
      const { anna, created } = await threeTransfers();
      for (const item of created) assert.equal(pick((await operationOf(h, anna, item)).body, 'status'), 'COMPLETED');
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
      for (const item of created) {
        const marks = await marksOf(h, item);
        if (digit(pick(item.body, 'number')) % 2 === 0) {
          assert.deepEqual(marks, []);
          continue;
        }
        assert.deepEqual(marks.map((mark) => [mark.code, mark.details.deliveries]), [['events.duplicate-delivery', 2]]);
        assert.ok(['bank.payments.created', 'bank.payments.status-changed'].includes(String(marks[0]?.details.topic)));
      }
    });

    it('после выключения сценарием события снова приходят по одному разу', async () => {
      await setDefects(h, ['events.duplicate-delivery']);
      await threeTransfers();
      await setDefects(h, []);
      const before = h.events.length;
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      await sendTransfer(h, anna, 'dup-key-0004', phoneTransfer(from.number, PETR, 100_000));
      await h.drain();
      const fresh = h.events.slice(before).filter((event) => event.topic.startsWith('bank.payments.'));
      assert.ok(fresh.length >= 4);
      assert.deepEqual(repeated(fresh.map((event) => (event.payload as { eventId: string }).eventId)), []);
    });
  });
});
