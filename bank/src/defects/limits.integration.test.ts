import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, markCount, marksOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, setDefects } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PETR, ANNA, IP } = PHONES;
const LIMIT = 15_000_000;
const EVENING = new Date('2026-10-20T20:30:00Z');
const JUST_AFTER_MIDNIGHT = new Date('2026-10-20T21:40:00Z');
const FOUR_IN_THE_MORNING = new Date('2026-10-21T01:00:00Z');

describe('сбои лимитов и комиссии, включаемые сценарием', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  const toBank = (from: string, amount: number) => phoneTransfer(from, '+79005550000', amount, { recipientBankCode: 'KEDR' });

  async function petrSends(key: string, amount: number) {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    return sendTransfer(h, petr, key, phoneTransfer(from.number, ANNA, amount));
  }

  describe('limit-boundary', () => {
    it('без сбоя перевод ровно на суточный лимит проходит, пометок нет', async () => {
      const created = await petrSends('limit-key-0001', LIMIT);
      assert.equal(pick(created.body, 'status'), 'CHECKING');
      assert.deepEqual(await marksOf(h, created), []);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем перевод ровно на лимит отклонён по лимиту и помечен', async () => {
      await setDefects(h, ['limit-boundary']);
      const created = await petrSends('limit-key-0002', LIMIT);
      assert.equal(pick(created.body, 'status'), 'REJECTED');
      assert.equal(pick(created.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
      const marks = await marksOf(h, created);
      assert.deepEqual(marks.map((mark) => mark.code), ['limit-boundary']);
      assert.deepEqual(marks[0]?.details, { expected: 'ACCEPTED', actual: 'DAILY_LIMIT_EXCEEDED', limit: LIMIT, usedToday: 0, usedTodayByMoscowDay: 0, amount: LIMIT });
      assert.equal(marks[0]?.createdAt.toISOString(), NOON_MOSCOW.toISOString());
    });

    it('со сбоем перевод на копейку меньше лимита и на копейку больше не помечаются', async () => {
      await setDefects(h, ['limit-boundary']);
      const below = await petrSends('limit-key-0003', LIMIT - 1);
      assert.equal(pick(below.body, 'status'), 'CHECKING');
      const above = await petrSends('limit-key-0004', LIMIT + 1);
      assert.equal(pick(above.body, 'status'), 'REJECTED');
      assert.equal(await markCount(h), 0);
    });
  });

  describe('daily-limit-utc', () => {
    async function twoNightTransfers(secondAt: Date, firstAt: Date, firstAmount: number, secondAmount: number) {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      h.setTime(firstAt);
      const first = await sendTransfer(h, petr, 'utc-key-0001', phoneTransfer(from.number, ANNA, firstAmount));
      h.setTime(secondAt);
      const second = await sendTransfer(h, petr, 'utc-key-0002', phoneTransfer(from.number, ANNA, secondAmount));
      return { first, second };
    }

    it('без сбоя после полуночи по Москве лимит новых суток свободен, пометок нет', async () => {
      const { first, second } = await twoNightTransfers(JUST_AFTER_MIDNIGHT, EVENING, 14_000_000, 14_000_000);
      assert.equal(pick(first.body, 'status'), 'CHECKING');
      assert.equal(pick(second.body, 'status'), 'CHECKING');
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем перевод в 00:40 по Москве считается во вчерашние сутки и отклоняется по лимиту', async () => {
      await setDefects(h, ['daily-limit-utc']);
      const { first, second } = await twoNightTransfers(JUST_AFTER_MIDNIGHT, EVENING, 14_000_000, 14_000_000);
      assert.equal(pick(first.body, 'status'), 'CHECKING');
      assert.equal(pick(second.body, 'status'), 'REJECTED');
      assert.equal(pick(second.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
      assert.deepEqual(await marksOf(h, first), []);
      const marks = await marksOf(h, second);
      assert.deepEqual(marks.map((mark) => mark.code), ['daily-limit-utc']);
      assert.deepEqual(marks[0]?.details, { expected: 'ACCEPTED', actual: 'DAILY_LIMIT_EXCEEDED', limit: LIMIT, usedToday: 14_000_000, usedTodayByMoscowDay: 0, amount: 14_000_000 });
    });

    it('со сбоем в 04:00 по Москве ночные переводы уже не считаются в лимит суток, и лимит превышается', async () => {
      await setDefects(h, ['daily-limit-utc']);
      const { first, second } = await twoNightTransfers(FOUR_IN_THE_MORNING, JUST_AFTER_MIDNIGHT, 14_000_000, 14_000_000);
      assert.equal(pick(first.body, 'status'), 'CHECKING');
      assert.equal(pick(second.body, 'status'), 'CHECKING');
      const marks = await marksOf(h, second);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details.expected, mark.details.actual]), [['daily-limit-utc', 'DAILY_LIMIT_EXCEEDED', 'ACCEPTED']]);
    });

    it('без сбоя тот же перевод в 04:00 отклонён: ночные переводы входят в те же сутки', async () => {
      const { second } = await twoNightTransfers(FOUR_IN_THE_MORNING, JUST_AFTER_MIDNIGHT, 14_000_000, 14_000_000);
      assert.equal(pick(second.body, 'status'), 'REJECTED');
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем в дневное время результат тот же, что без сбоя, и пометок нет', async () => {
      await setDefects(h, ['daily-limit-utc']);
      const { first, second } = await twoNightTransfers(NOON_MOSCOW, NOON_MOSCOW, 14_000_000, 2_000_000);
      assert.equal(pick(first.body, 'status'), 'CHECKING');
      assert.equal(pick(second.body, 'status'), 'REJECTED');
      assert.equal(await markCount(h), 0);
    });

    it('данные о лимите в профиле показывают сутки по UTC только со сбоем', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      h.setTime(EVENING);
      await sendTransfer(h, petr, 'utc-key-0003', phoneTransfer(from.number, ANNA, 1_000_000));
      h.setTime(JUST_AFTER_MIDNIGHT);
      const used = async () => pick((await h.api(petr, 'GET', '/api/v1/me')).body, 'limits.dailyPhoneTransfer.used');
      assert.equal(await used(), 0);
      await setDefects(h, ['daily-limit-utc']);
      assert.equal(await used(), 1_000_000);
    });
  });

  describe('commission-rounding', () => {
    async function ipPaysFee(key: string, amount: number) {
      const ip = await h.login(IP);
      const from = await accountOf(h, ip);
      await sendTransfer(h, ip, `${key}-free`, toBank(from.number, 10_000_000));
      await h.drain();
      return sendTransfer(h, ip, key, toBank(from.number, amount));
    }

    it('без сбоя комиссия округляется до копейки, пометок нет', async () => {
      const created = await ipPaysFee('fee-key-0001', 456_789);
      assert.equal(pick(created.body, 'fee'), 4_568);
      assert.equal(await markCount(h), 0);
    });

    it('со сбоем комиссия теряет копейки, перевод помечен с ожидаемой и фактической комиссией', async () => {
      await setDefects(h, ['commission-rounding']);
      const created = await ipPaysFee('fee-key-0002', 456_789);
      assert.equal(pick(created.body, 'fee'), 4_500);
      const marks = await marksOf(h, created);
      assert.deepEqual(marks.map((mark) => [mark.code, mark.details]), [['commission-rounding', { expected: 4_568, actual: 4_500 }]]);
      await h.drain();
      const done = await h.api(await h.login(IP), 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`);
      assert.equal(pick(done.body, 'total'), 456_789 + 4_500);
    });

    it('со сбоем комиссия по минимуму, без копеек и внутренний перевод не помечаются', async () => {
      await setDefects(h, ['commission-rounding']);
      const minimum = await ipPaysFee('fee-key-0003', 100_000);
      assert.equal(pick(minimum.body, 'fee'), 3_000);
      const whole = await ipPaysFee('fee-key-0004', 500_000);
      assert.equal(pick(whole.body, 'fee'), 5_000);
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const internal = await sendTransfer(h, petr, 'fee-key-0005', phoneTransfer(from.number, ANNA, 456_789));
      assert.equal(pick(internal.body, 'fee'), 0);
      assert.equal(await markCount(h), 0);
    });
  });
});
