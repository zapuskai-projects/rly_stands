import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileKey } from './profile-refresh';

describe('обновление профиля клиента', () => {
  it('на каждом экране ключ свой: после перевода и при возврате на форму профиль грузится заново', () => {
    const form = profileKey('/transfer');
    const operation = profileKey('/operations/ZB0000100004');
    assert.notEqual(form, operation);
    assert.notEqual(operation, profileKey('/transfer'.concat('/own')));
    assert.equal(profileKey('/transfer'), form);
  });

  it('косая черта в конце адреса ключ не меняет', () => {
    assert.equal(profileKey('/transfer/'), profileKey('/transfer'));
    assert.equal(profileKey('/'), '/');
  });
});
