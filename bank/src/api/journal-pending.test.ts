import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PendingWrites } from './journal-pending';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('ожидание записей журнала запросов', () => {
  it('без записей с такой меткой не ждёт вовсе', async () => {
    const pending = new PendingWrites();
    const started = Date.now();
    await pending.settle('a', 1000);
    pending.track('b', delay(200));
    pending.track(null, delay(200));
    await pending.settle('a', 1000);
    assert.ok(Date.now() - started < 150);
  });

  it('ждёт незаписанные строки своей метки и не ждёт чужие', async () => {
    const pending = new PendingWrites();
    let written = false;
    pending.track('a', delay(80).then(() => {
      written = true;
    }));
    pending.track('b', delay(400));
    await pending.settle('a', 1000);
    assert.equal(written, true);
  });

  it('не ждёт дольше срока, провалившаяся запись не мешает', async () => {
    const pending = new PendingWrites();
    pending.track('a', delay(500));
    pending.track('a', Promise.reject(new Error('база недоступна')));
    const started = Date.now();
    await pending.settle('a', 60);
    const spent = Date.now() - started;
    assert.ok(spent >= 50 && spent < 300, `ждали ${spent} мс`);
  });

  it('после завершения записи метка снова свободна', async () => {
    const pending = new PendingWrites();
    pending.track('a', delay(20));
    await pending.settle('a', 1000);
    const started = Date.now();
    await pending.settle('a', 1000);
    assert.ok(Date.now() - started < 50);
  });
});
