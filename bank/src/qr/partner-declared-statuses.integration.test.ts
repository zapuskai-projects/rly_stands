import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadContract } from '../api/contract';
import { PARTNER_OPENAPI_PATH } from '../config';
import { LAVKA_PARTNER_KEY } from '../partners/partner-key';
import { releaseAtLeast } from '../release/release';
import { startHarness, type Harness } from '../testing/harness';
import { NOON_MOSCOW, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const IDS = ['nonexistent', '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', '%00'];
const BODIES: unknown[] = [
  {},
  { orderId: 'o-1', amount: 'x', description: 5 },
  { orderId: 'o-2', amount: 1000, description: 'Заказ', ttlSeconds: 10 },
  { orderId: 'o-3', amount: 1000, description: 'Заказ' },
  [1, 2, 3],
  'не объект',
];
const KEYS: Array<Record<string, string>> = [{}, { 'X-Partner-Key': 'wrong' }, { 'X-Partner-Key': LAVKA_PARTNER_KEY }];

describe('каждый ответ партнёрского API описан в контракте', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  for (const release of ['1.1', '1.2'] as const) {
    it(`релиз ${release}: обход операций с разными ключами и испорченными запросами не даёт неописанных статусов`, async () => {
      await useRelease(h, release);
      const contract = loadContract(PARTNER_OPENAPI_PATH);
      const violations = new Set<string>();
      let requests = 0;
      for (const operation of contract.operations) {
        const available = operation.release === null || releaseAtLeast(release, operation.release);
        const hasPathParams = operation.openApiPath.includes('{');
        const hasBody = operation.method !== 'get' && operation.method !== 'delete';
        for (const headers of KEYS) {
          for (const id of hasPathParams ? IDS : ['']) {
            const path = operation.openApiPath.replace(/\{[^}]+\}/g, id);
            for (const body of hasBody ? BODIES : [undefined]) {
              const response = await h.api(null, operation.method.toUpperCase(), path, body, headers);
              requests += 1;
              const code = (response.body as { code?: string } | null)?.code;
              const unparsable = response.status === 400 && code === 'MALFORMED_JSON';
              if (!available) {
                if (!unparsable && (response.status !== 404 || code !== 'NOT_FOUND')) violations.add(`${operation.method} ${operation.openApiPath} → ${response.status} на релизе ${release}`);
              } else if (!operation.responses.has(response.status) && !unparsable) {
                violations.add(`${operation.method} ${operation.openApiPath} → ${response.status}`);
              }
            }
          }
        }
      }
      assert.ok(requests > 30, `обход сделал только ${requests} запросов`);
      assert.deepEqual([...violations].sort(), []);
    });
  }
});
