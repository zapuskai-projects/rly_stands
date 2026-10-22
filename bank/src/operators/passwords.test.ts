import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from './passwords';

describe('пароли операторов', () => {
  it('верный пароль проходит, неверный нет', () => {
    const stored = hashPassword('operator-2026');
    assert.equal(verifyPassword('operator-2026', stored), true);
    assert.equal(verifyPassword('operator-2027', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  it('хэш солёный: один пароль даёт разные записи', () => {
    assert.notEqual(hashPassword('same-password'), hashPassword('same-password'));
  });

  it('пароль в записи не хранится', () => {
    assert.ok(!hashPassword('secret-pass').includes('secret-pass'));
  });

  it('повреждённая запись не проходит', () => {
    assert.equal(verifyPassword('x', 'plain'), false);
    assert.equal(verifyPassword('x', 'scrypt$zz$'), false);
    assert.equal(verifyPassword('x', ''), false);
  });
});
