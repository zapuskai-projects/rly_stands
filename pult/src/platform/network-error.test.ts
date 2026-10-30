import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeNetworkError } from './network-error';
import { checkAttempt, fetchAttemptProbes } from './client';

const PLATFORM = 'https://api.education.zapuskai.com';
const AUTH = { platformUrl: PLATFORM, token: 'test-token', kitVersion: '0.1.14' };

describe('ожидание проверки задачи', () => {
  it('медленная проверка завершается, обычный запрос сохраняет короткий предел ожидания', async (context) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => timeout(milliseconds / 1000));
    context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ status: 'PASSED' }))), 80);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        }, { once: true });
      }),
    );
    const checked = await checkAttempt(AUTH, 'attempt', {});
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.value.status, 'PASSED');
    const probes = await fetchAttemptProbes(AUTH, 'attempt');
    assert.equal(probes.ok, false);
  });

  it('тайм-аут проверки объясняет ожидание результата, сбой сети остаётся сбоем сети', async (context) => {
    context.mock.method(globalThis, 'fetch', async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    const pending = await checkAttempt(AUTH, 'attempt', {});
    assert.equal(pending.ok, false);
    if (!pending.ok) {
      assert.match(pending.message, /Результат может появиться позже/);
      assert.doesNotMatch(pending.message, /Платформа недоступна/);
    }
    context.mock.restoreAll();
    context.mock.method(globalThis, 'fetch', async () => {
      throw fetchFailure('ENOTFOUND', 'getaddrinfo ENOTFOUND api.education.zapuskai.com');
    });
    const failed = await checkAttempt(AUTH, 'attempt', {});
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.message, /ENOTFOUND/);
  });
});

function fetchFailure(code: string, message: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

describe('describeNetworkError', () => {
  it('подменённый сертификат — про антивирус и сеть на работе, с адресом платформы', () => {
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const text = describeNetworkError(fetchFailure(code, 'certificate problem'), PLATFORM);
      assert.match(text, /не доверяет сертификату api\.education\.zapuskai\.com/);
      assert.match(text, /антивирус/);
      assert.doesNotMatch(text, /fetch failed/);
    }
  });

  it('сертификат не по дате — про дату и время на компьютере', () => {
    const text = describeNetworkError(fetchFailure('CERT_NOT_YET_VALID', 'certificate is not yet valid'), PLATFORM);
    assert.match(text, /проверку по дате/);
    assert.match(text, /дату и время/);
  });

  it('прочие сбои — текст самой глубокой причины вместо «fetch failed»', () => {
    const text = describeNetworkError(
      fetchFailure('ENOTFOUND', 'getaddrinfo ENOTFOUND api.education.zapuskai.com'),
      PLATFORM,
    );
    assert.equal(text, 'getaddrinfo ENOTFOUND api.education.zapuskai.com');
  });

  it('не ошибка и кривой адрес не ломают текст', () => {
    assert.equal(describeNetworkError('oops', PLATFORM), 'нет ответа');
    assert.match(describeNetworkError(fetchFailure('CERT_UNTRUSTED', 'x'), 'не адрес'), /сертификату не адрес/);
  });
});
