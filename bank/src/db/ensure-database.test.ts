import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitDatabaseUrl } from './ensure-database';

describe('адрес базы банка', () => {
  it('имя базы отделяется, адрес служебной базы строится от того же сервера и учётки', () => {
    const target = splitDatabaseUrl('postgres://student:student@postgres:5432/bank');
    assert.equal(target.database, 'bank');
    assert.equal(target.adminUrl, 'postgres://student:student@postgres:5432/postgres');
  });

  it('параметры подключения сохраняются', () => {
    assert.equal(splitDatabaseUrl('postgres://u:p@h:5433/bank_2?sslmode=disable').adminUrl, 'postgres://u:p@h:5433/postgres?sslmode=disable');
  });

  it('пустое и небезопасное имя базы отвергается', () => {
    assert.throws(() => splitDatabaseUrl('postgres://u:p@h:5432/'), /имя базы/);
    assert.throws(() => splitDatabaseUrl('postgres://u:p@h:5432/ba%22nk'), /имя базы/);
    assert.throws(() => splitDatabaseUrl('postgres://u:p@h:5432/bank-name'), /имя базы/);
  });

  it('не адрес вообще — ошибка разбора', () => {
    assert.throws(() => splitDatabaseUrl('не адрес'));
  });
});
