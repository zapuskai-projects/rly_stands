import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliveryRows, qrRows } from './bank-facts';

describe('признаки для проверок доставок и QR-кодов', () => {
  it('у доставки есть признаки «были повторы» и «первая попытка 5xx»', () => {
    const rows = deliveryRows([
      { eventId: 'e-1', status: 'DELIVERED', attemptsMade: 3, attempts: [{ statusCode: 500 }, { statusCode: null, error: 'TIMEOUT' }, { statusCode: 200 }] },
      { eventId: 'e-2', status: 'DELIVERED', attemptsMade: 1, attempts: [{ statusCode: 200 }] },
      { eventId: 'e-3', status: 'DELIVERED', attemptsMade: 2, attempts: [{ statusCode: null, error: 'ECONNREFUSED' }, { statusCode: 200 }] },
      { eventId: 'e-4', status: 'PENDING', attemptsMade: 1, attempts: [] },
    ]) as { retried: boolean; firstAttempt5xx: boolean }[];
    assert.deepEqual(rows.map((row) => [row.retried, row.firstAttempt5xx]), [[true, true], [false, false], [true, false], [false, false]]);
  });

  it('у QR-кода есть признак «несколько возвратов»', () => {
    const rows = qrRows([{ id: 'a', status: 'REFUNDED', refunds: [{ id: 1 }, { id: 2 }] }, { id: 'b', status: 'REFUNDED', refunds: [{ id: 1 }] }, { id: 'c', status: 'CREATED' }]) as { multipleRefunds: boolean }[];
    assert.deepEqual(rows.map((row) => row.multipleRefunds), [true, false, false]);
  });
});
