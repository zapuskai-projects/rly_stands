import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { BankClock } from '../clock/bank-clock';
import { handleCreatedMessage } from './handlers';

const unusedDeps = { pool: {} as Pool, clock: new BankClock() };
const message = (value: string) => ({ value, key: '10000001', headers: { operationId: 'op-1', requestId: 'req-12345678' } });

describe('разбор событий антифродом', () => {
  it('испорченные сообщения пропускаются без повторов и без оценки', async () => {
    const sent: unknown[] = [];
    const send = async (decision: unknown) => {
      sent.push(decision);
    };
    await handleCreatedMessage(unusedDeps, send, message('не JSON'));
    await handleCreatedMessage(unusedDeps, send, message('{}'));
    await handleCreatedMessage(unusedDeps, send, message(JSON.stringify({ operationId: 'не uuid', operationNumber: 'n', clientNumber: 'c', type: 'PHONE_TRANSFER', amount: 5 })));
    await handleCreatedMessage(unusedDeps, send, message(JSON.stringify({ operationId: '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10', operationNumber: 'n', clientNumber: 'c', type: 'PHONE_TRANSFER', amount: -5 })));
    assert.deepEqual(sent, []);
  });

  it('перевод между своими счетами не оценивается', async () => {
    const sent: unknown[] = [];
    const payload = { operationId: '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10', operationNumber: 'ZB1', clientNumber: '10000001', type: 'OWN_TRANSFER', amount: 5 };
    await handleCreatedMessage(unusedDeps, async (decision) => void sent.push(decision), message(JSON.stringify(payload)));
    assert.deepEqual(sent, []);
  });
});
