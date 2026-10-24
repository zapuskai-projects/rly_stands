import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPartnerKey, LAVKA_PARTNER_KEY, sameHash } from './partner-key';

describe('ключ магазина', () => {
  it('хешируется SHA-256 и хеш не равен ключу', () => {
    const hash = hashPartnerKey(LAVKA_PARTNER_KEY);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, LAVKA_PARTNER_KEY);
    assert.equal(hashPartnerKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('разные ключи дают разные хеши, сравнение не путает длину', () => {
    assert.equal(sameHash(hashPartnerKey('a'), hashPartnerKey('a')), true);
    assert.equal(sameHash(hashPartnerKey('a'), hashPartnerKey('b')), false);
    assert.equal(sameHash('abc', hashPartnerKey('a')), false);
  });
});
