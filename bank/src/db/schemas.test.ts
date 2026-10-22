import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUSINESS_SCHEMA, INTERNAL_SCHEMA, parseSearchPath, searchPathOptions } from './schemas';

describe('схемы базы банка', () => {
  it('по умолчанию бизнес-таблицы в public, служебные в kit_internal, порядок в search_path тот же', () => {
    assert.equal(BUSINESS_SCHEMA, 'public');
    assert.equal(INTERNAL_SCHEMA, 'kit_internal');
    assert.equal(searchPathOptions(), '-c search_path=public,kit_internal');
    assert.equal(searchPathOptions({ business: 'a', internal: 'b' }), '-c search_path=a,b');
  });

  it('search_path разбирается в две схемы, кавычки и пробелы отбрасываются', () => {
    assert.deepEqual(parseSearchPath('public, kit_internal'), { business: 'public', internal: 'kit_internal' });
    assert.deepEqual(parseSearchPath('"bank_test_1", "bank_test_1_internal"'), { business: 'bank_test_1', internal: 'bank_test_1_internal' });
  });

  it('одна схема, три схемы, пустое и небезопасное имя отвергаются', () => {
    for (const value of ['public', '', '"$user", public, kit_internal', 'public,', 'public, bad-name', 'a;drop, b']) {
      assert.throws(() => parseSearchPath(value), /search_path из двух схем/, value);
    }
  });
});
