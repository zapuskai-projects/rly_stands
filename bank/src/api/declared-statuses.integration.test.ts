import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OPENAPI_PATH } from '../config';
import { KIT_TEST_SECRET, startHarness, type Harness } from '../testing/harness';
import { accountOf, NOON_MOSCOW, PHONES, phoneTransfer } from '../testing/scenarios';
import { loadContract, type OperationSpec } from './contract';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const IDS = ['nonexistent', '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', 'ZB9999999999', 'START', 'GOLD'];
const BODIES: unknown[] = [{}, { amount: 'x', phone: 5, code: [] }, [1, 2, 3], 'не объект'];
const QUERIES = ['', '?limit=abc&offset=-1', '?phone=bad&status=NOPE&query=%00', '?limit=1000000'];
const LAST = new Set(['logout', 'logoutOperator']);

type Doc = { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { example?: unknown }> } }>> };

function exampleOf(document: unknown, operation: OperationSpec): unknown[] {
  const example = (document as Doc).paths[operation.openApiPath]?.[operation.method]?.requestBody?.content?.['application/json']?.example;
  return example === undefined ? [] : [example];
}

describe('каждый ответ банка описан в контракте', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  it('обход всех операций контракта разными токенами, ключами и испорченными запросами не даёт ни одного статуса, которого нет в описании', async () => {
    const contract = loadContract(OPENAPI_PATH);
    const anna = await h.login(ANNA);
    const blocked = await h.login(PETR);
    await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE phone = $1", [PETR]);
    const operator = await h.operatorLogin();
    const senior = await h.operatorLogin('senior');
    const tokens: Array<string | null> = [null, anna, blocked, operator, senior];

    const operations = [...contract.operations].sort((a, b) => Number(LAST.has(a.operationId)) - Number(LAST.has(b.operationId)));
    const violations = new Set<string>();
    let requests = 0;

    const hit = async (operation: OperationSpec, token: string | null, path: string, body: unknown, headers: Record<string, string>) => {
      const response = await h.api(token, operation.method.toUpperCase(), path, body, headers);
      requests += 1;
      if (!operation.responses.has(response.status)) {
        violations.add(`${operation.method.toUpperCase()} ${operation.openApiPath} → ${response.status}`);
      }
    };

    for (const operation of operations) {
      const hasPathParams = operation.openApiPath.includes('{');
      const hasBody = operation.method !== 'get' && operation.method !== 'delete';
      for (const token of tokens) {
        for (const id of hasPathParams ? IDS : ['']) {
          const base = operation.openApiPath.replace(/\{[^}]+\}/g, id);
          for (const query of operation.method === 'get' ? QUERIES : ['']) {
            for (const body of hasBody ? [...exampleOf(contract.document, operation), ...BODIES] : [undefined]) {
              await hit(operation, token, `${base}${query}`, body, { 'Idempotency-Key': 'declared-key-0001' });
              if (hasBody) await hit(operation, token, `${base}${query}`, body, {});
            }
          }
        }
      }
    }

    assert.ok(requests > 1000, `обход сделал только ${requests} запросов`);
    assert.deepEqual([...violations].sort(), []);
  });

  it('типичные отказы по правилам банка (закрытый вход, неверный код, недостаток средств, чужой получатель, ключ повтора с другим телом) описаны в контракте', async () => {
    const contract = loadContract(OPENAPI_PATH);
    const operationOf = (id: string) => contract.operations.find((item) => item.operationId === id) as OperationSpec;
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const from = await accountOf(h, anna);
    const petrFrom = await accountOf(h, petr);
    const operator = await h.operatorLogin();
    await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE phone = $1", [PETR]);

    const seen: Array<[string, number]> = [];
    const call = async (id: string, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await h.api(token, method, path, body, headers);
      seen.push([id, response.status]);
      return response;
    };

    await call('requestLoginCode', null, 'POST', '/api/v1/auth/login', { phone: PETR });
    await call('requestLoginCode', null, 'POST', '/api/v1/auth/login', { phone: '+79990000000' });
    await call('verifyLoginCode', null, 'POST', '/api/v1/auth/verify', { challengeId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', code: '000000' });
    const challenge = await h.api(null, 'POST', '/api/v1/auth/login', { phone: ANNA });
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await call('verifyLoginCode', null, 'POST', '/api/v1/auth/verify', { challengeId: String(challenge.body && (challenge.body as { challengeId: string }).challengeId), code: '000000' });
    }
    await call('createTransfer', petr, 'POST', '/api/v1/transfers', phoneTransfer(petrFrom.number, ANNA, 10_000), { 'Idempotency-Key': 'rule-blocked-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, PETR, 10_000), { 'Idempotency-Key': 'rule-recipient-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, '+79990000000', 10_000), { 'Idempotency-Key': 'rule-unknown-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, PHONES.GALINA, 99_999_999_999), { 'Idempotency-Key': 'rule-funds-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, PHONES.GALINA, 10_000), { 'Idempotency-Key': 'rule-replay-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, PHONES.GALINA, 20_000), { 'Idempotency-Key': 'rule-replay-0001' });
    await call('createTransfer', anna, 'POST', '/api/v1/transfers', phoneTransfer('40817810000000000009', PHONES.GALINA, 10_000), { 'Idempotency-Key': 'rule-account-0001' });
    await call('lookupRecipient', anna, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(PETR)}`);
    await call('lookupRecipient', anna, 'GET', `/api/v1/recipients/lookup?phone=${encodeURIComponent(ANNA)}`);
    await call('lookupRecipient', anna, 'GET', '/api/v1/recipients/lookup?phone=%2B79990000000&bankCode=NOPE');
    await call('approveReview', operator, 'POST', '/api/v1/office/reviews/0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/approve', { comment: 'ок' });
    await call('rejectReview', operator, 'POST', '/api/v1/office/reviews/0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/reject', { comment: 'нет' });
    await call('setClientDailyLimit', operator, 'PUT', '/api/v1/office/clients/0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/daily-limit', { amount: 1 });
    await call('loginOperator', null, 'POST', '/api/v1/office/auth/login', { login: 'operator', password: 'неверный' });

    const undeclared = seen.filter(([id, status]) => !operationOf(id).responses.has(status)).map(([id, status]) => `${id} → ${status}`);
    assert.ok(seen.length > 15);
    assert.deepEqual([...new Set(undeclared)].sort(), []);
  });
});

