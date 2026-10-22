import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDatabaseConflict, retryOnConflict } from './retry';

const conflict = (code: string) => Object.assign(new Error(`ошибка ${code}`), { code });

describe('повтор при конфликте с фоновой работой', () => {
  it('взаимная блокировка, сбой сериализации и таймаут блокировки считаются конфликтом, остальное нет', () => {
    assert.equal(isDatabaseConflict(conflict('40P01')), true);
    assert.equal(isDatabaseConflict(conflict('40001')), true);
    assert.equal(isDatabaseConflict(conflict('55P03')), true);
    assert.equal(isDatabaseConflict(conflict('23505')), false);
    assert.equal(isDatabaseConflict(new Error('без кода')), false);
    assert.equal(isDatabaseConflict(null), false);
  });

  it('повторяет работу до успеха и сообщает о каждом повторе', async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await retryOnConflict(
      async () => {
        calls += 1;
        if (calls < 3) throw conflict('40P01');
        return 'готово';
      },
      { delayMs: 1, onRetry: (_error, attempt) => retries.push(attempt) },
    );
    assert.equal(result, 'готово');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
  });

  it('другая ошибка не повторяется', async () => {
    let calls = 0;
    await assert.rejects(
      retryOnConflict(
        async () => {
          calls += 1;
          throw conflict('23505');
        },
        { delayMs: 1 },
      ),
      /23505/,
    );
    assert.equal(calls, 1);
  });

  it('после последней попытки отдаёт ошибку', async () => {
    let calls = 0;
    await assert.rejects(
      retryOnConflict(
        async () => {
          calls += 1;
          throw conflict('40P01');
        },
        { attempts: 3, delayMs: 1 },
      ),
      /40P01/,
    );
    assert.equal(calls, 3);
  });
});
