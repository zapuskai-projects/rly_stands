import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeviceCall, DeviceLoginStatus } from '../platform/device';
import { generateKitToken, tokenFingerprint } from '../platform/device';
import type { SessionResult } from '../platform/types';
import { sessionAfterLogin, waitForApproval } from './session';

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function answers(...values: Array<DeviceCall<DeviceLoginStatus>>) {
  const queue = [...values];
  let calls = 0;
  return {
    poll: async () => {
      calls += 1;
      return queue.shift() ?? { ok: true as const, value: 'PENDING' as const };
    },
    calls: () => calls,
  };
}

describe('вход по коду', () => {
  it('токен пульта того же вида, что выдаёт платформа, а наружу уходит только отпечаток', () => {
    const token = generateKitToken();
    assert.match(token, /^sk_[A-Za-z0-9_-]{43}$/);
    assert.match(tokenFingerprint(token), /^[0-9a-f]{64}$/);
    assert.notEqual(tokenFingerprint(token), tokenFingerprint(generateKitToken()));
  });

  it('ждёт подтверждения и переживает сбой сети', async () => {
    const clock = fakeClock();
    const retries: string[] = [];
    const source = answers(
      { ok: true, value: 'PENDING' },
      { ok: false, message: 'Платформа недоступна', retry: true },
      { ok: false, message: 'Платформа недоступна', retry: true },
      { ok: true, value: 'APPROVED' },
    );
    const outcome = await waitForApproval(source.poll, {
      intervalMs: 3000,
      deadline: 600_000,
      ...clock,
      onRetry: (message) => retries.push(message),
    });
    assert.equal(outcome, 'APPROVED');
    assert.equal(source.calls(), 4);
    assert.deepEqual(retries, ['Платформа недоступна']);
  });

  it('отказ на сайте и истёкший срок — без бесконечного ожидания', async () => {
    assert.equal(
      await waitForApproval(answers({ ok: true, value: 'DENIED' }).poll, { intervalMs: 3000, deadline: 600_000, ...fakeClock() }),
      'DENIED',
    );
    const source = answers();
    assert.equal(await waitForApproval(source.poll, { intervalMs: 3000, deadline: 9000, ...fakeClock() }), 'EXPIRED');
    assert.equal(source.calls(), 3);
  });

  it('ошибка без смысла повторять — сразу наружу', async () => {
    const outcome = await waitForApproval(answers({ ok: false, message: 'Обновите набор', retry: false }).poll, {
      intervalMs: 3000,
      deadline: 600_000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { error: 'Обновите набор' });
  });

  it('после подтверждения сессию запрашивает повторно при обрыве, но не при отказе', async () => {
    const unreachable: SessionResult = { ok: false, kind: 'unreachable', message: 'нет связи' };
    const rejected: SessionResult = { ok: false, kind: 'rejected', message: 'отозван' };
    const noWait = async () => {};
    let calls = 0;
    const flaky = async (): Promise<SessionResult> => {
      calls += 1;
      return calls < 3 ? unreachable : rejected;
    };
    assert.equal((await sessionAfterLogin(flaky, noWait)).ok, false);
    assert.equal(calls, 3);
    calls = 0;
    const refused = async (): Promise<SessionResult> => {
      calls += 1;
      return rejected;
    };
    await sessionAfterLogin(refused, noWait);
    assert.equal(calls, 1);
  });
});
