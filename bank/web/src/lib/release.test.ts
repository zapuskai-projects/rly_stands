import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bankVersionLabel, gateDecision, releaseAtLeast } from './release';

describe('версия банка на экране', () => {
  it('подпись — название и номер релиза', () => {
    assert.equal(bankVersionLabel('1.0'), 'ЗапускБанк 1.0');
    assert.equal(bankVersionLabel('1.1'), 'ЗапускБанк 1.1');
  });

  it('без релиза или с чужим форматом подписи нет', () => {
    assert.equal(bankVersionLabel(undefined), null);
    assert.equal(bankVersionLabel(''), null);
    assert.equal(bankVersionLabel('latest'), null);
  });
});

describe('доступность функций релиза в интерфейсе', () => {
  it('функции 1.1 видны с релиза 1.1 и выше, на 1.0 и без ответа банка не видны', () => {
    assert.equal(releaseAtLeast('1.1', '1.1'), true);
    assert.equal(releaseAtLeast('1.2', '1.1'), true);
    assert.equal(releaseAtLeast('1.0', '1.1'), false);
    assert.equal(releaseAtLeast(null, '1.1'), false);
    assert.equal(releaseAtLeast(undefined, '1.1'), false);
    assert.equal(releaseAtLeast('latest', '1.1'), false);
  });

  it('экран релиза 1.1: пока релиз неизвестен — ждём, на 1.0 и без ответа банка — как несуществующая страница, с 1.1 — показываем', () => {
    assert.equal(gateDecision(true, null, '1.1'), 'wait');
    assert.equal(gateDecision(false, '1.0', '1.1'), 'hide');
    assert.equal(gateDecision(false, null, '1.1'), 'hide');
    assert.equal(gateDecision(false, '1.1', '1.1'), 'show');
    assert.equal(gateDecision(false, '1.2', '1.1'), 'show');
  });
});
