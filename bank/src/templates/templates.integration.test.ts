import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getTopics } from '../events/topics';
import { loadAsyncApi } from '../testing/asyncapi';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NIGHT_MOSCOW, NOON_MOSCOW, operationOf, PHONES, phoneTransfer, sendTransfer, settledTransfer, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR, GALINA } = PHONES;
const NORTHWIND_PHONE = '+79000000021';

describe('шаблоны переводов', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    await useRelease(h, '1.1');
  });

  afterEach(async () => {
    await h.close();
  });

  const create = (token: string, body: unknown) => h.api(token, 'POST', '/api/v1/templates', body);
  const byTemplate = (token: string, id: string, key: string, body?: unknown) =>
    h.api(token, 'POST', `/api/v1/templates/${id}/transfers`, body, { 'Idempotency-Key': key });

  async function annaWithTemplate(extra: Record<string, unknown> = {}) {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    const created = await create(token, { name: 'Пётр', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, ...extra });
    assert.equal(created.status, 201);
    return { token, from, id: String(pick(created.body, 'id')) };
  }

  async function checkClient(balanceKop: number): Promise<{ token: string; number: string }> {
    const made = await h.kit('POST', '/_kit/actions/check-client', { tariffCode: 'START', balanceKop });
    assert.equal(made.status, 200);
    return { token: await h.login(String(pick(made.body, 'phone'))), number: String(pick(made.body, 'accountNumber')) };
  }

  it('шаблон вручную: вид PHONE, банк получателя по умолчанию ЗапускБанк, сумма необязательна', async () => {
    const { token, id } = await annaWithTemplate({ amount: 500_000, comment: 'Маме' });
    const list = await h.api(token, 'GET', '/api/v1/templates');
    assert.equal(list.status, 200);
    const item = (pick(list.body, 'items') as Record<string, unknown>[])[0];
    assert.equal(item?.id, id);
    assert.equal(item?.kind, 'PHONE');
    assert.equal(item?.recipientPhone, PETR);
    assert.equal(item?.recipientBankCode, 'ZAPUSK');
    assert.equal(item?.recipientBankName, 'ЗапускБанк');
    assert.equal(item?.amount, 500_000);
    assert.equal(item?.comment, 'Маме');
    assert.equal(item?.toAccount, null);
    const empty = await create(token, { name: 'Без суммы', kind: 'SBP', fromAccount: (await accountOf(h, token)).number, recipientPhone: NORTHWIND_PHONE, recipientBankCode: 'NORTHWIND' });
    assert.equal(empty.status, 201);
    assert.equal(pick(empty.body, 'amount'), null);
    assert.equal(pick(empty.body, 'recipientBankName'), 'Банк «Северный ветер»');
  });

  it('шаблон между своими счетами требует свой счёт зачисления, шаблон в другой банк — банк из справочника', async () => {
    const token = await h.login(ANNA);
    const current = await accountOf(h, token, 0);
    const savings = await accountOf(h, token, 1);
    const own = await create(token, { name: 'Копилка', kind: 'OWN', fromAccount: current.number, toAccount: savings.number });
    assert.equal(own.status, 201);
    assert.equal(pick(own.body, 'toAccount'), savings.number);
    assert.equal(pick(own.body, 'recipientPhone'), null);
    assert.equal(pick((await create(token, { name: 'Сам себе', kind: 'OWN', fromAccount: current.number, toAccount: current.number })).body, 'code'), 'SAME_ACCOUNT');
    assert.equal(pick((await create(token, { name: 'Чужой', kind: 'OWN', fromAccount: current.number, toAccount: '40817810000000000009' })).body, 'code'), 'ACCOUNT_NOT_FOUND');
    assert.equal(pick((await create(token, { name: 'Без счёта', kind: 'OWN', fromAccount: current.number })).body, 'details.0.field'), 'body.toAccount');
    assert.equal(pick((await create(token, { name: 'Не банк', kind: 'SBP', fromAccount: current.number, recipientPhone: PETR, recipientBankCode: 'NOPE' })).body, 'code'), 'UNKNOWN_BANK');
    assert.equal((await create(token, { name: 'Не банк 2', kind: 'SBP', fromAccount: current.number, recipientPhone: PETR })).status, 400);
    assert.equal((await create(token, { name: 'Не СБП', kind: 'PHONE', fromAccount: current.number, recipientPhone: PETR, recipientBankCode: 'NORTHWIND' })).status, 400);
    assert.equal((await create(token, { name: 'Нет вида' })).status, 400);
    assert.equal((await create(token, { name: 'Чужой счёт', kind: 'PHONE', fromAccount: '40817810000000000009', recipientPhone: PETR })).status, 422);
  });

  it('шаблон из выполненной операции берёт вид, получателя, сумму и сообщение; чужая, невыполненная и свои счета тоже работают', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const from = await accountOf(h, anna);
    const done = await settledTransfer(h, anna, 'tpl-from-op-01', phoneTransfer(from.number, PETR, 150_000, { comment: 'За обед' }));
    const made = await create(anna, { name: 'Обед', fromOperationId: pick(done.body, 'id') });
    assert.equal(made.status, 201);
    assert.deepEqual(
      ['kind', 'recipientPhone', 'amount', 'comment', 'fromAccount'].map((field) => pick(made.body, field)),
      ['PHONE', PETR, 150_000, 'За обед', from.number],
    );

    const savings = await accountOf(h, anna, 1);
    const own = await sendTransfer(h, anna, 'tpl-from-op-02', { type: 'OWN_TRANSFER', fromAccount: from.number, toAccount: savings.number, amount: 100_000 });
    const ownTemplate = await create(anna, { name: 'Свои', fromOperationId: pick(own.body, 'id') });
    assert.equal(pick(ownTemplate.body, 'kind'), 'OWN');
    assert.equal(pick(ownTemplate.body, 'toAccount'), savings.number);

    const external = await settledTransfer(h, anna, 'tpl-from-op-03', phoneTransfer(from.number, NORTHWIND_PHONE, 120_000, { recipientBankCode: 'NORTHWIND' }));
    assert.equal(pick(external.body, 'status'), 'COMPLETED');
    const sbpTemplate = await create(anna, { name: 'Иван', fromOperationId: pick(external.body, 'id') });
    assert.equal(pick(sbpTemplate.body, 'kind'), 'SBP');
    assert.equal(pick(sbpTemplate.body, 'recipientBankCode'), 'NORTHWIND');

    const pending = await sendTransfer(h, anna, 'tpl-from-op-04', phoneTransfer(from.number, GALINA, 100_000));
    const notDone = await create(anna, { name: 'Ещё идёт', fromOperationId: pick(pending.body, 'id') });
    assert.equal(notDone.status, 422);
    assert.equal(pick(notDone.body, 'code'), 'OPERATION_NOT_COMPLETED');

    const foreign = await create(petr, { name: 'Чужая', fromOperationId: pick(done.body, 'id') });
    assert.equal(foreign.status, 404);
    assert.equal(pick(foreign.body, 'code'), 'OPERATION_NOT_FOUND');
    assert.equal((await create(anna, { name: 'Лишнее', fromOperationId: pick(done.body, 'id'), amount: 100 })).status, 400);
  });

  it('не больше 20 шаблонов; название от 1 до 40 символов и без повторов без учёта регистра', async () => {
    const token = await h.login(ANNA);
    const from = (await accountOf(h, token)).number;
    const make = (name: string) => create(token, { name, kind: 'PHONE', fromAccount: from, recipientPhone: PETR });
    for (let index = 1; index <= 20; index += 1) assert.equal((await make(`Шаблон ${index}`)).status, 201, String(index));
    const over = await make('Лишний');
    assert.equal(over.status, 422);
    assert.equal(pick(over.body, 'code'), 'TEMPLATE_LIMIT_REACHED');
    const taken = await make('шаблон 7');
    assert.equal(pick(taken.body, 'code'), 'TEMPLATE_LIMIT_REACHED');

    const other = await h.login(PETR);
    const otherFrom = (await accountOf(h, other)).number;
    const first = await create(other, { name: 'Аренда', kind: 'PHONE', fromAccount: otherFrom, recipientPhone: ANNA });
    assert.equal(first.status, 201);
    const duplicate = await create(other, { name: 'аРЕНДА', kind: 'PHONE', fromAccount: otherFrom, recipientPhone: ANNA });
    assert.equal(duplicate.status, 409);
    assert.equal(pick(duplicate.body, 'code'), 'TEMPLATE_NAME_TAKEN');
    assert.equal((await create(other, { name: 'я'.repeat(40), kind: 'PHONE', fromAccount: otherFrom, recipientPhone: ANNA })).status, 201);
    for (const name of ['', '   ', 'я'.repeat(41)]) {
      const rejected = await create(other, { name, kind: 'PHONE', fromAccount: otherFrom, recipientPhone: ANNA });
      assert.equal(rejected.status, 400, JSON.stringify(name));
      assert.equal(pick(rejected.body, 'code'), 'VALIDATION_ERROR');
    }
    assert.equal((await create(token, { name: 'Аренда', kind: 'PHONE', fromAccount: from, recipientPhone: PETR })).status, 422);
  });

  it('изменение шаблона: название, сумма, null убирает сумму; занятое название — 409; удаление освобождает название', async () => {
    const { token, id, from } = await annaWithTemplate({ amount: 100_000 });
    const second = await create(token, { name: 'Второй', kind: 'PHONE', fromAccount: from.number, recipientPhone: GALINA });
    const patch = (templateId: string, body: unknown) => h.api(token, 'PATCH', `/api/v1/templates/${templateId}`, body);

    const renamed = await patch(id, { name: 'Новое имя', amount: 250_000 });
    assert.equal(renamed.status, 200);
    assert.deepEqual([pick(renamed.body, 'name'), pick(renamed.body, 'amount')], ['Новое имя', 250_000]);
    assert.equal(pick((await patch(id, { amount: null })).body, 'amount'), null);
    assert.equal(pick((await patch(id, { name: 'второй' })).body, 'code'), 'TEMPLATE_NAME_TAKEN');
    assert.equal((await patch(id, { name: 'НОВОЕ ИМЯ' })).status, 200);
    assert.equal((await patch(id, {})).status, 400);
    assert.equal((await patch('0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', { name: 'X' })).status, 404);

    const removed = await h.api(token, 'DELETE', `/api/v1/templates/${id}`);
    assert.equal(removed.status, 204);
    assert.equal(((await h.api(token, 'GET', '/api/v1/templates')).body as { items: unknown[] }).items.length, 1);
    assert.equal(pick(await patch(id, { name: 'Ещё раз' }), 'status'), 404);
    assert.equal(pick(await h.api(token, 'DELETE', `/api/v1/templates/${id}`), 'body.code'), 'TEMPLATE_NOT_FOUND');
    assert.equal((await create(token, { name: 'Новое имя', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR })).status, 201);
    assert.equal(pick(second.body, 'name'), 'Второй');
  });

  it('чужой шаблон недоступен: изменить, удалить и провести перевод нельзя', async () => {
    const { id } = await annaWithTemplate({ amount: 100_000 });
    const petr = await h.login(PETR);
    assert.equal((await h.api(petr, 'PATCH', `/api/v1/templates/${id}`, { name: 'Мой' })).status, 404);
    assert.equal((await h.api(petr, 'DELETE', `/api/v1/templates/${id}`)).status, 404);
    assert.equal((await byTemplate(petr, id, 'tpl-foreign-001')).status, 404);
    assert.deepEqual(((await h.api(petr, 'GET', '/api/v1/templates')).body as { items: unknown[] }).items, []);
    assert.equal((await h.api(null, 'GET', '/api/v1/templates')).status, 401);
  });

  it('перевод по шаблону: сумма шаблона, сумма запроса её заменяет, без суммы — AMOUNT_REQUIRED; операция и событие несут templateId', async () => {
    const { token, id, from } = await annaWithTemplate({ amount: 120_000, comment: 'За июнь' });
    const plain = await byTemplate(token, id, 'tpl-transfer-01');
    assert.equal(plain.status, 201);
    assert.equal(pick(plain.body, 'templateId'), id);
    assert.equal(pick(plain.body, 'amount'), 120_000);
    assert.equal(pick(plain.body, 'comment'), 'За июнь');
    assert.equal(pick(plain.body, 'type'), 'PHONE_TRANSFER');
    assert.equal(pick(plain.body, 'recipient.phone'), PETR);

    const changed = await byTemplate(token, id, 'tpl-transfer-02', { amount: 130_000, comment: 'Другое' });
    assert.equal(pick(changed.body, 'amount'), 130_000);
    assert.equal(pick(changed.body, 'comment'), 'Другое');

    await h.api(token, 'PATCH', `/api/v1/templates/${id}`, { amount: null });
    const noAmount = await byTemplate(token, id, 'tpl-transfer-03');
    assert.equal(noAmount.status, 422);
    assert.equal(pick(noAmount.body, 'code'), 'AMOUNT_REQUIRED');
    assert.equal(pick(await byTemplate(token, id, 'tpl-transfer-03', {}), 'body.code'), 'AMOUNT_REQUIRED');
    assert.equal((await byTemplate(token, id, 'tpl-transfer-04', { amount: 0 })).status, 400);
    assert.equal((await h.api(token, 'POST', `/api/v1/templates/${id}/transfers`, { amount: 100 })).status, 400);
    assert.equal((await byTemplate(token, id, 'tpl-transfer-05', { amount: 110_000 })).status, 201);

    await h.drain();
    const finished = await operationOf(h, token, plain);
    assert.equal(pick(finished.body, 'status'), 'COMPLETED');
    assert.equal(pick(finished.body, 'templateId'), id);
    const listed = (pick((await h.api(token, 'GET', '/api/v1/operations')).body, 'items') as { templateId?: string | null }[]).filter((item) => item.templateId === id);
    assert.equal(listed.length, 3);

    const created = h.events.filter((event) => event.topic === getTopics().paymentsCreated);
    assert.equal(created.length, 3);
    for (const event of created) {
      assert.equal((event.payload as { templateId: string }).templateId, id);
      assert.equal(loadAsyncApi('1.1').payloadValidator('bank.payments.created')(event.payload).ok, true);
    }
    assert.equal((await accountOf(h, token)).balance, from.balance - 120_000 - 130_000 - 110_000);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('обычный перевод на 1.1 несёт templateId: null в ответе и событии', async () => {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    const plain = await sendTransfer(h, token, 'plain-on-11-001', phoneTransfer(from.number, PETR, 100_000));
    assert.equal(pick(plain.body, 'templateId'), null);
    await h.drain();
    const created = h.events.filter((event) => event.topic === getTopics().paymentsCreated);
    assert.equal((created[0]?.payload as { templateId: unknown }).templateId, null);
    assert.equal(loadAsyncApi('1.1').payloadValidator('bank.payments.created')(created[0]?.payload).ok, true);
  });

  it('повтор запроса с тем же ключом возвращает ту же операцию, с другой суммой — IDEMPOTENCY_KEY_REUSED, ключ обязателен', async () => {
    const { token, id, from } = await annaWithTemplate({ amount: 120_000 });
    const first = await byTemplate(token, id, 'tpl-replay-0001');
    const second = await byTemplate(token, id, 'tpl-replay-0001');
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(pick(second.body, 'id'), pick(first.body, 'id'));
    const reused = await byTemplate(token, id, 'tpl-replay-0001', { amount: 130_000 });
    assert.equal(reused.status, 422);
    assert.equal(pick(reused.body, 'code'), 'IDEMPOTENCY_KEY_REUSED');
    await h.drain();
    assert.equal((await accountOf(h, token)).balance, from.balance - 120_000);
  });

  it('правило: суточный лимит действует и на перевод по шаблону — на копейку больше отклоняется, без комиссии', async () => {
    const token = await h.login(PETR);
    const from = await accountOf(h, token);
    const made = await create(token, { name: 'Анне', kind: 'PHONE', fromAccount: from.number, recipientPhone: ANNA });
    const id = String(pick(made.body, 'id'));
    const atLimit = await byTemplate(token, id, 'tpl-limit-0001', { amount: 15_000_000 });
    assert.equal(pick(atLimit.body, 'status'), 'CHECKING');
    await h.drain();
    assert.equal(pick(await operationOf(h, token, atLimit), 'body.status'), 'COMPLETED');
    const over = await byTemplate(token, id, 'tpl-limit-0002', { amount: 1 });
    assert.equal(over.status, 201);
    assert.equal(pick(over.body, 'status'), 'REJECTED');
    assert.equal(pick(over.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
    assert.equal(pick(over.body, 'fee'), 0);
    assert.equal(pick(over.body, 'templateId'), id);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('правило: комиссия за перевод в другой банк по шаблону такая же, как за обычный', async () => {
    const plainClient = await checkClient(50_000_000);
    const templateClient = await checkClient(50_000_000);
    const plain = await sendTransfer(h, plainClient.token, 'tpl-fee-plain-01', phoneTransfer(plainClient.number, NORTHWIND_PHONE, 13_000_000, { recipientBankCode: 'NORTHWIND' }));
    const made = await create(templateClient.token, { name: 'Иван', kind: 'SBP', fromAccount: templateClient.number, recipientPhone: NORTHWIND_PHONE, recipientBankCode: 'NORTHWIND' });
    const viaTemplate = await byTemplate(templateClient.token, String(pick(made.body, 'id')), 'tpl-fee-templ-01', { amount: 13_000_000 });
    assert.equal(pick(plain.body, 'fee'), 30_000);
    assert.equal(pick(viaTemplate.body, 'fee'), pick(plain.body, 'fee'));
    assert.equal(pick(viaTemplate.body, 'route'), 'SBP');
    await h.drain();
    assert.equal(pick(await operationOf(h, templateClient.token, viaTemplate), 'body.status'), 'COMPLETED');
    assert.equal((await accountOf(h, templateClient.token)).balance, 50_000_000 - 13_000_000 - 30_000);
  });

  it('правило: недостаток средств — отказ 422 без операции, арест счёта — операция REJECTED', async () => {
    const poor = await checkClient(1_000_000);
    const made = await create(poor.token, { name: 'Анне', kind: 'PHONE', fromAccount: poor.number, recipientPhone: ANNA });
    const id = String(pick(made.body, 'id'));
    const lacking = await byTemplate(poor.token, id, 'tpl-funds-0001', { amount: 2_000_000 });
    assert.equal(lacking.status, 422);
    assert.equal(pick(lacking.body, 'code'), 'INSUFFICIENT_FUNDS');
    assert.equal(((await h.api(poor.token, 'GET', '/api/v1/operations')).body as { total: number }).total, 0);

    await h.pool.query("UPDATE accounts SET status = 'ARRESTED' WHERE number = $1", [poor.number]);
    const arrested = await byTemplate(poor.token, id, 'tpl-funds-0002', { amount: 100_000 });
    assert.equal(pick(arrested.body, 'status'), 'REJECTED');
    assert.equal(pick(arrested.body, 'rejection.code'), 'ACCOUNT_ARRESTED');
  });

  it('правило: антифрод и ручная проверка — ночной перевод по шаблону уходит на проверку, оператор одобряет и деньги доходят', async () => {
    h.setTime(NIGHT_MOSCOW);
    const { token, id, from } = await annaWithTemplate();
    const night = await byTemplate(token, id, 'tpl-review-0001', { amount: 2_000_000 });
    await h.drain();
    const reviewing = await operationOf(h, token, night);
    assert.equal(pick(reviewing.body, 'status'), 'ON_REVIEW');
    assert.equal(pick(reviewing.body, 'templateId'), id);
    assert.equal((await accountOf(h, token)).available, from.balance - 2_000_000);

    const operator = await h.operatorLogin();
    const approved = await h.api(operator, 'POST', `/api/v1/office/reviews/${String(pick(night.body, 'id'))}/approve`, { comment: 'Клиент подтвердил' });
    assert.equal(approved.status, 200);
    await h.drain();
    assert.equal(pick(await operationOf(h, token, night), 'body.status'), 'COMPLETED');
    assert.equal((await accountOf(h, token)).balance, from.balance - 2_000_000);

    const other = await create(token, { name: 'Галине', kind: 'PHONE', fromAccount: from.number, recipientPhone: GALINA });
    const second = await byTemplate(token, String(pick(other.body, 'id')), 'tpl-review-0002', { amount: 6_000_000 });
    await h.drain();
    assert.equal(pick(await operationOf(h, token, second), 'body.status'), 'ON_REVIEW');
    const rejected = await h.api(operator, 'POST', `/api/v1/office/reviews/${String(pick(second.body, 'id'))}/reject`, { comment: 'Подозрительный получатель' });
    assert.equal(rejected.status, 200);
    assert.equal(pick(await operationOf(h, token, second), 'body.rejection.code'), 'OPERATOR_REJECTED');
  });

  it('офис видит шаблоны клиента только для чтения', async () => {
    const { id } = await annaWithTemplate({ amount: 100_000 });
    const operator = await h.operatorLogin();
    const client = await h.pool.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [ANNA]);
    const response = await h.api(operator, 'GET', `/api/v1/office/clients/${(client.rows[0] as { id: string }).id}/templates`);
    assert.equal(response.status, 200);
    assert.equal(pick(response.body, 'items.0.id'), id);
    assert.equal((await h.api(operator, 'GET', '/api/v1/office/clients/0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/templates')).status, 404);
    const token = await h.login(ANNA);
    assert.equal((await h.api(token, 'GET', `/api/v1/office/clients/${(client.rows[0] as { id: string }).id}/templates`)).status, 401);
  });
});
