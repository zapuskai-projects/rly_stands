import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBearerToken, generateAccessToken, generateLoginCode, hashSecret } from './codes';

describe('коды входа и токены', () => {
  it('код входа состоит из шести цифр', () => {
    for (let i = 0; i < 200; i += 1) assert.match(generateLoginCode(), /^[0-9]{6}$/);
  });

  it('токен уникален и имеет префикс', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateAccessToken()));
    assert.equal(tokens.size, 100);
    for (const token of tokens) assert.match(token, /^zb_[A-Za-z0-9_-]{43}$/);
  });

  it('отпечаток стабилен и не равен исходному значению', () => {
    assert.equal(hashSecret('123456'), hashSecret('123456'));
    assert.notEqual(hashSecret('123456'), hashSecret('123457'));
    assert.match(hashSecret('x'), /^[0-9a-f]{64}$/);
  });

  it('токен достаётся из заголовка Authorization', () => {
    assert.equal(extractBearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(extractBearerToken('bearer abc'), 'abc');
    assert.equal(extractBearerToken('Basic abc'), null);
    assert.equal(extractBearerToken('Bearer'), null);
    assert.equal(extractBearerToken('Bearer a b'), null);
    assert.equal(extractBearerToken(undefined), null);
  });
});
