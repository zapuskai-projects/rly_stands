import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foreignKeyFacts, type KeyRow } from './postgres-keys';

const ROWS: KeyRow[] = [
  { table: 'accounts', kind: 'p', column: 'id', refTable: null, refColumn: null },
  { table: 'accounts', kind: 'f', column: 'client_id', refTable: 'clients', refColumn: 'id' },
  { table: 'clients', kind: 'p', column: 'id', refTable: null, refColumn: null },
  { table: 'postings', kind: 'p', column: 'id', refTable: null, refColumn: null },
  { table: 'postings', kind: 'f', column: 'debit_account_id', refTable: 'accounts', refColumn: 'id' },
  { table: 'postings', kind: 'f', column: 'credit_account_id', refTable: 'accounts', refColumn: 'id' },
  { table: 'postings', kind: 'f', column: 'operation_id', refTable: 'operations', refColumn: 'id' },
];

describe('postgres.foreignKeys: ключи таблиц схемы', () => {
  it('внешние ключи: таблица, колонка, на какую таблицу', () => {
    const facts = foreignKeyFacts(ROWS, undefined);
    assert.equal(facts.count, 4);
    assert.deepEqual(facts.foreignKeys[0], { table: 'accounts', column: 'client_id', refTable: 'clients', refColumn: 'id' });
  });

  it('по таблице: первичный ключ, поля-ссылки, таблицы-цели и ключевые колонки без повторов', () => {
    const { postings, clients } = foreignKeyFacts(ROWS, undefined).byTable;
    assert.deepEqual(postings?.foreignKeyColumns, ['debit_account_id', 'credit_account_id', 'operation_id']);
    assert.deepEqual(postings?.refTables, ['accounts', 'operations']);
    assert.deepEqual(postings?.keyColumns, ['id', 'debit_account_id', 'credit_account_id', 'operation_id']);
    assert.deepEqual(clients, { primaryKey: ['id'], foreignKeyColumns: [], refTables: [], keyColumns: ['id'] });
  });

  it('фильтр по именам таблиц', () => {
    const facts = foreignKeyFacts(ROWS, ['accounts', 'clients']);
    assert.deepEqual(facts.tables, ['accounts', 'clients']);
    assert.equal(facts.count, 1);
  });

  it('составной первичный ключ сохраняет порядок колонок', () => {
    const rows: KeyRow[] = [
      { table: 't', kind: 'p', column: 'a', refTable: null, refColumn: null },
      { table: 't', kind: 'p', column: 'b', refTable: null, refColumn: null },
    ];
    assert.deepEqual(foreignKeyFacts(rows, undefined).byTable.t?.primaryKey, ['a', 'b']);
  });
});
