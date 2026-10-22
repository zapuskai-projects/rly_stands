import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOutage, transactionControl, txFailure } from './postgres';

describe('isOutage', () => {
  it('обрыв соединения и остановка сервера — это недоступность', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '08006', '57P01', '57P03']) {
      assert.equal(isOutage({ code }), true, code);
    }
  });

  it('долгий запрос студента, отменённый по таймауту, — не недоступность', () => {
    assert.equal(isOutage({ code: '57014' }), false);
  });

  it('ошибки SQL и ошибки без кода — не недоступность', () => {
    for (const error of [{ code: '42P01' }, { code: '23505' }, { code: '42601' }, new Error('x'), {}]) {
      assert.equal(isOutage(error), false);
    }
  });
});

describe('postgres.tx: защита транзакции проверки', () => {
  it('управление транзакцией запрещено в любом месте скрипта', () => {
    for (const sql of ['COMMIT', 'select 1; commit', 'INSERT INTO t VALUES (1);\n  rollback;', 'begin; select 1', 'END', 'savepoint a', 'PREPARE TRANSACTION \'x\'']) {
      assert.ok(transactionControl(sql), sql);
    }
  });

  it('слова в строках и обычные запросы не мешают', () => {
    for (const sql of ["INSERT INTO t (stage) VALUES ('commit; end')", 'SELECT count(*) FROM t', "UPDATE t SET stage = 'begin'", 'DELETE FROM t WHERE id = 1; SELECT 1']) {
      assert.equal(transactionControl(sql), null, sql);
    }
  });

  it('ошибка SQL превращается в факты с кодом и ограничением', () => {
    const facts = txFailure(Object.assign(new Error('insert or update on table violates foreign key constraint'), { code: '23503', constraint: 'document_counterparty_id_fkey' }));
    assert.equal(facts.failed, true);
    assert.equal(facts.code, '23503');
    assert.equal(facts.constraint, 'document_counterparty_id_fkey');
    assert.match(facts.error ?? '', /foreign key/);
    assert.deepEqual(facts.rows, []);
    assert.equal(txFailure(new Error('x')).code, null);
  });
});
