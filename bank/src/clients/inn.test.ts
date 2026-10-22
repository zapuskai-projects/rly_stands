import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidInn } from './inn';

describe('проверка ИНН', () => {
  it('известные верные ИНН организации и физического лица', () => {
    assert.equal(isValidInn('7707083893'), true);
    assert.equal(isValidInn('500100732259'), true);
  });

  it('смена контрольной цифры делает ИНН неверным', () => {
    assert.equal(isValidInn('7707083894'), false);
    assert.equal(isValidInn('500100732258'), false);
    assert.equal(isValidInn('500100732249'), false);
  });

  it('неверная длина и не цифры отвергаются', () => {
    assert.equal(isValidInn('770708389'), false);
    assert.equal(isValidInn('77070838930'), false);
    assert.equal(isValidInn('77070838АА'), false);
    assert.equal(isValidInn(''), false);
  });
});
