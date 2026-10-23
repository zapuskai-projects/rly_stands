import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { restoredBankTime, sbpScenario, startTraffic, trafficTransfer } from './monitoring-bank';

describe('учения по сбою СБП банка', () => {
  it('сбой включается режимом REJECT, спокойный период — NORMAL, сбои банка выключены', () => {
    assert.deepEqual(sbpScenario('REJECT', 'noon'), { reset: false, defects: [], sbpMode: 'REJECT', bankTime: 'noon' });
    assert.equal(sbpScenario('NORMAL', 'night').sbpMode, 'NORMAL');
  });

  it('фоновый перевод — в другой банк через СБП, с уникальным ключом повтора', () => {
    const first = trafficTransfer('+79990000001', 'ab12', 0);
    const second = trafficTransfer('+79990000001', 'ab12', 1);
    assert.equal(first.toBankCode, 'NORTHWIND');
    assert.equal(first.phone, '+79990000001');
    assert.notEqual(first.idempotencyKey, second.idempotencyKey);
    assert.match(first.idempotencyKey, /^[A-Za-z0-9._:{}-]{8,64}$/);
  });

  it('поток шлёт переводы по порядку до остановки и считает только принятые', async () => {
    const indexes: number[] = [];
    const gate: { resume: (() => void) | null } = { resume: null };
    const pause = () => new Promise<void>((resolve) => (gate.resume = resolve));
    const traffic = startTraffic(
      async (index) => {
        indexes.push(index);
        if (index === 1) throw new Error('банк не ответил');
      },
      pause,
      1,
    );
    for (let step = 0; step < 3; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      gate.resume?.();
    }
    const stopping = traffic.stop();
    gate.resume?.();
    const sent = await stopping;
    assert.deepEqual(indexes.slice(0, 3), [0, 1, 2]);
    assert.equal(sent, indexes.length - 1);
  });
});

describe('время банка после учений', () => {
  it('время было сдвинуто — возвращается прежнее с поправкой на прошедшее время', () => {
    assert.equal(restoredBankTime({ now: '2026-10-23T09:00:00.000Z', shifted: true }, 90_000), '2026-10-23T09:01:30.000Z');
  });

  it('время было настоящим — возвращается настоящее', () => {
    assert.equal(restoredBankTime({ now: '2026-10-23T09:00:00.000Z', shifted: false }, 90_000), null);
  });
});
