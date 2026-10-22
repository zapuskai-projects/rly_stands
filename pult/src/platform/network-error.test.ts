import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeNetworkError } from './network-error';

const PLATFORM = 'https://api.education.zapuskai.com';

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
