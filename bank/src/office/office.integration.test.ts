import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NIGHT_MOSCOW, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, settledTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;

describe('операционный офис', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let operator: string;
  let senior: string;

  async function startAt(instant: Date): Promise<void> {
    h = await startHarness(DATABASE_URL as string, instant);
    operator = await h.operatorLogin('operator');
    senior = await h.operatorLogin('senior');
  }

  afterEach(async () => {
    await h.close();
  });

  const clientIdByNumber = async (number: string): Promise<string> =>
    String(pick((await h.api(operator, 'GET', `/api/v1/office/clients?query=${number}`)).body, 'items.0.id'));

  describe('вход и роли', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    it('оператор и старший оператор входят с учебными паролями, профиль называет роль', async () => {
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/me')).body, 'role'), 'OPERATOR');
      assert.equal(pick((await h.api(senior, 'GET', '/api/v1/office/me')).body, 'shortName'), 'Светлана К.');
    });

    it('неверный пароль и неизвестный логин дают одну и ту же ошибку', async () => {
      const wrong = await h.api(null, 'POST', '/api/v1/office/auth/login', { login: 'operator', password: 'неверный' });
      const unknown = await h.api(null, 'POST', '/api/v1/office/auth/login', { login: 'nobody', password: 'неверный' });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(pick(wrong.body, 'message'), pick(unknown.body, 'message'));
    });

    it('после выхода токен оператора перестаёт действовать', async () => {
      assert.equal((await h.api(operator, 'POST', '/api/v1/office/auth/logout')).status, 204);
      assert.equal((await h.api(operator, 'GET', '/api/v1/office/me')).status, 401);
    });

    it('пароль в базе не хранится открытым текстом', async () => {
      const hashes = await h.pool.query('SELECT password_hash FROM operators');
      for (const row of hashes.rows) assert.ok(!String(row.password_hash).includes('-2026'));
    });
  });

  describe('тарифы и лимиты', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    it('тарифы читает любой оператор', async () => {
      const response = await h.api(operator, 'GET', '/api/v1/office/tariffs');
      assert.deepEqual((pick(response.body, 'items') as { code: string }[]).map((item) => item.code), ['START', 'PENSION']);
    });

    it('правит тариф только старший оператор, новый лимит действует на следующий перевод', async () => {
      const values = { dailyPhoneTransferLimit: 10_000_000, freeMonthlyVolume: 10_000_000, commissionRateBps: 100, commissionMin: 3_000, commissionMax: 150_000 };
      assert.equal((await h.api(operator, 'PUT', '/api/v1/office/tariffs/START', values)).status, 403);
      const updated = await h.api(senior, 'PUT', '/api/v1/office/tariffs/START', values);
      assert.equal(updated.status, 200);
      assert.equal(pick(updated.body, 'dailyPhoneTransferLimit'), 10_000_000);

      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const over = await sendTransfer(h, petr, 'tariff-key-0001', phoneTransfer(from.number, ANNA, 10_000_001));
      assert.equal(pick(over.body, 'status'), 'REJECTED');
      const atLimit = await settledTransfer(h, petr, 'tariff-key-0002', phoneTransfer(from.number, ANNA, 10_000_000));
      assert.equal(pick(atLimit.body, 'status'), 'COMPLETED');
    });

    it('минимум комиссии больше максимума и неизвестный тариф отвергаются', async () => {
      const values = { dailyPhoneTransferLimit: 10_000_000, freeMonthlyVolume: 10_000_000, commissionRateBps: 100, commissionMin: 5_000, commissionMax: 4_000 };
      const invalid = await h.api(senior, 'PUT', '/api/v1/office/tariffs/START', values);
      assert.equal(invalid.status, 422);
      assert.equal(pick(invalid.body, 'code'), 'INVALID_TARIFF');
      assert.equal((await h.api(senior, 'PUT', '/api/v1/office/tariffs/GOLD', { ...values, commissionMin: 1 })).status, 404);
    });

    it('личный лимит клиента заменяет лимит тарифа и снимается значением null', async () => {
      const clientId = await clientIdByNumber('10000001');
      assert.equal((await h.api(operator, 'PUT', `/api/v1/office/clients/${clientId}/daily-limit`, { dailyPhoneTransferLimit: 100_000 })).status, 403);
      const set = await h.api(senior, 'PUT', `/api/v1/office/clients/${clientId}/daily-limit`, { dailyPhoneTransferLimit: 100_000 });
      assert.equal(pick(set.body, 'dailyLimitOverride'), 100_000);
      assert.equal(pick(set.body, 'limits.dailyPhoneTransfer.limit'), 100_000);

      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      assert.equal(pick((await sendTransfer(h, anna, 'override-key-0001', phoneTransfer(from.number, PETR, 100_001))).body, 'status'), 'REJECTED');
      const reset = await h.api(senior, 'PUT', `/api/v1/office/clients/${clientId}/daily-limit`, { dailyPhoneTransferLimit: null });
      assert.equal(pick(reset.body, 'dailyLimitOverride'), null);
      assert.equal(pick(reset.body, 'limits.dailyPhoneTransfer.limit'), 15_000_000);
    });
  });

  describe('клиенты, операции, уведомления', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    it('поиск клиентов по имени, телефону и номеру', async () => {
      const byName = await h.api(operator, 'GET', '/api/v1/office/clients?query=соколова');
      assert.equal(pick(byName.body, 'total'), 1);
      assert.equal(pick(byName.body, 'items.0.fullName'), 'Анна Соколова');
      assert.equal(pick((await h.api(operator, 'GET', `/api/v1/office/clients?query=${encodeURIComponent('+79001110006')}`)).body, 'items.0.fullName'), 'Сергей Мартынов');
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/clients?query=10000004')).body, 'items.0.kind'), 'ENTREPRENEUR');
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/clients')).body, 'total'), 6);
    });

    it('карточка клиента: счета, тариф, лимиты и история из сида', async () => {
      const clientId = await clientIdByNumber('10000001');
      const card = await h.api(operator, 'GET', `/api/v1/office/clients/${clientId}`);
      assert.equal(pick(card.body, 'client.customerSince'), '2024-03-12T09:00:00.000+03:00');
      assert.equal(pick(card.body, 'tariff.code'), 'START');
      assert.equal(pick(card.body, 'accounts.0.balance'), 12_000_000);
      assert.equal(pick(card.body, 'client.accountsCount'), 2);
      assert.equal(pick(card.body, 'client.totalBalance'), 12_000_000 + 1_500_000);
      const recent = pick(card.body, 'recentOperations') as { recipient: { displayName: string }; amount: number; status: string }[];
      assert.deepEqual(recent.map((item) => [item.recipient.displayName, item.amount, item.status]), [
        ['Иван К.', 250_000, 'COMPLETED'],
        ['Иван К.', 400_000, 'COMPLETED'],
        ['Ольга С.', 630_000, 'COMPLETED'],
      ]);
      assert.equal(pick(card.body, 'limits.monthlyFreeVolume.used') as number >= 0, true);
      assert.equal((await h.api(operator, 'GET', '/api/v1/office/clients/00000000-0000-4000-8000-000000000000')).status, 404);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('операции ищутся по номеру целиком у любого клиента, карточка показывает оценку антифрода', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      const done = await settledTransfer(h, petr, 'office-key-0001', phoneTransfer(from.number, ANNA, 100_000));
      const number = String(pick(done.body, 'number'));
      const found = await h.api(operator, 'GET', `/api/v1/office/operations?number=${number}`);
      assert.equal(pick(found.body, 'total'), 1);
      assert.equal(pick(found.body, 'items.0.clientName'), 'Пётр Ильин');
      const detail = await h.api(operator, 'GET', `/api/v1/office/operations/${String(pick(done.body, 'id'))}`);
      assert.equal(pick(detail.body, 'operation.status'), 'COMPLETED');
      assert.equal(pick(detail.body, 'antifraud.decision'), 'APPROVE');
      assert.equal(pick(detail.body, 'antifraud.rules.0.code'), 'NEW_RECIPIENT');
      assert.equal(pick(detail.body, 'review'), null);
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/operations?status=COMPLETED&clientNumber=10000001')).body, 'total'), 3);
      assert.equal((await h.api(operator, 'GET', '/api/v1/office/operations/00000000-0000-4000-8000-000000000000')).status, 404);
    });

    it('журнал уведомлений: коды входа и проведения, фильтры по телефону, виду и каналу', async () => {
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      await settledTransfer(h, anna, 'notify-key-0001', phoneTransfer(from.number, PETR, 100_000));
      const all = await h.api(operator, 'GET', '/api/v1/office/notifications');
      assert.equal(pick(all.body, 'total'), 5);
      const byPhone = await h.api(operator, 'GET', `/api/v1/office/notifications?phone=${encodeURIComponent(PETR)}`);
      assert.equal(pick(byPhone.body, 'total'), 2);
      assert.equal(pick(byPhone.body, 'items.0.clientName'), 'Пётр Ильин');
      assert.match(String(pick(byPhone.body, 'items.0.operationNumber')), /^ZB[0-9]{10}$/);
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/notifications?kind=LOGIN_CODE')).body, 'total'), 1);
      assert.equal(pick((await h.api(operator, 'GET', '/api/v1/office/notifications?kind=TRANSFER_COMPLETED&channel=PUSH')).body, 'total'), 1);
    });
  });

  describe('карточка ручной проверки', () => {
    beforeEach(() => startAt(NIGHT_MOSCOW));

    it('показывает клиента, обычную сумму, пороги и прошлые операции без самой проверяемой', async () => {
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      const created = await sendTransfer(h, anna, 'card-key-0001', phoneTransfer(from.number, PETR, 1_500_000));
      await h.drain();
      const id = String(pick(created.body, 'id'));
      const details = await h.api(operator, 'GET', `/api/v1/office/reviews/${id}`);
      assert.equal(details.status, 200);
      assert.equal(pick(details.body, 'review.score'), 72);
      assert.deepEqual(pick(details.body, 'thresholds'), { review: 70, reject: 90 });
      assert.equal(pick(details.body, 'client.fullName'), 'Анна Соколова');
      assert.equal(pick(details.body, 'client.usualAmount'), 426_667);
      assert.equal(pick(details.body, 'client.accountNumber'), from.number);
      assert.equal((pick(details.body, 'recentOperations') as unknown[]).length, 3);
      assert.equal(pick(details.body, 'review.rules.2.description'), 'Сумма больше обычной в 3 раза или первый перевод клиента');
      assert.equal((await h.api(operator, 'GET', '/api/v1/office/reviews/00000000-0000-4000-8000-000000000000')).status, 404);
    });
  });

  describe('поиск получателя при переводе', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    const lookup = (token: string, phone: string, bankCode?: string) =>
      h.api(token, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(phone)}${bankCode ? `&bankCode=${bankCode}` : ''}`);

    it('внутри банка называет получателя и отмечает нового', async () => {
      const anna = await h.login(ANNA);
      const first = await lookup(anna, PETR);
      assert.deepEqual([pick(first.body, 'displayName'), pick(first.body, 'known'), pick(first.body, 'bankName')], ['Пётр И.', false, 'ЗапускБанк']);
      const from = await accountOf(h, anna);
      await settledTransfer(h, anna, 'lookup-key-0001', phoneTransfer(from.number, PETR, 100_000));
      assert.equal(pick((await lookup(anna, PETR)).body, 'known'), true);
    });

    it('в другом банке имя даёт справочник СБП, номер вне справочника остаётся без имени', async () => {
      const anna = await h.login(ANNA);
      const known = await lookup(anna, '+79000000017', 'NORTHWIND');
      assert.deepEqual([pick(known.body, 'displayName'), pick(known.body, 'known')], ['Мария П.', false]);
      assert.equal(pick((await lookup(anna, '+79000000021', 'NORTHWIND')).body, 'known'), true);
      assert.equal(pick((await lookup(anna, '+79005550000', 'KEDR')).body, 'displayName'), null);
    });

    it('имя из справочника сохраняется в операции перевода в другой банк', async () => {
      const anna = await h.login(ANNA);
      const from = await accountOf(h, anna);
      const created = await sendTransfer(h, anna, 'lookup-key-0002', phoneTransfer(from.number, '+79000000017', 100_000, { recipientBankCode: 'NORTHWIND' }));
      assert.equal(pick(created.body, 'recipient.displayName'), 'Мария П.');
    });

    it('неизвестный номер в банке, неизвестный банк и самому себе отвергаются', async () => {
      const anna = await h.login(ANNA);
      assert.equal(pick((await lookup(anna, '+79009998877')).body, 'code'), 'RECIPIENT_NOT_FOUND');
      assert.equal(pick((await lookup(anna, PETR, 'NOBANK')).body, 'code'), 'UNKNOWN_BANK');
      assert.equal(pick((await lookup(anna, ANNA)).body, 'code'), 'RECIPIENT_IS_SENDER');
      assert.equal((await h.api(null, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(PETR)}`)).status, 401);
    });
  });
});
