import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { Client } from 'pg';
import { ensureDatabase, splitDatabaseUrl } from './ensure-database';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe('создание базы банка при старте', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  const created: string[] = [];

  const urlFor = (name: string): string => {
    const url = new URL(DATABASE_URL as string);
    url.pathname = `/${name}`;
    return url.toString();
  };

  const freshName = (): string => {
    const name = `bank_ensure_${randomBytes(5).toString('hex')}`;
    created.push(name);
    return name;
  };

  const exists = async (name: string): Promise<boolean> => {
    const admin = new Client({ connectionString: splitDatabaseUrl(urlFor(name)).adminUrl });
    await admin.connect();
    try {
      return ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount ?? 0) > 0;
    } finally {
      await admin.end();
    }
  };

  afterEach(async () => {
    const admin = new Client({ connectionString: splitDatabaseUrl(DATABASE_URL as string).adminUrl });
    await admin.connect();
    for (const name of created.splice(0)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it('создаёт базу, которой нет, и не трогает существующую', async () => {
    const name = freshName();
    assert.equal(await exists(name), false);
    assert.equal(await ensureDatabase(urlFor(name)), true);
    assert.equal(await exists(name), true);
    assert.equal(await ensureDatabase(urlFor(name)), false);
    const client = new Client({ connectionString: urlFor(name) });
    await client.connect();
    assert.equal((await client.query('SELECT 1 AS one')).rows[0]?.one, 1);
    await client.end();
  });

  it('три роли банка стартуют одновременно: база создаётся один раз, никто не падает', async () => {
    const name = freshName();
    const results = await Promise.all([ensureDatabase(urlFor(name)), ensureDatabase(urlFor(name)), ensureDatabase(urlFor(name))]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await exists(name), true);
  });

  it('служебная база postgres уже есть, ничего не создаётся', async () => {
    assert.equal(await ensureDatabase(urlFor('postgres')), false);
  });

  it('недоступный сервер даёт ошибку подключения, а не молчание', async () => {
    const url = new URL(DATABASE_URL as string);
    url.port = '1';
    await assert.rejects(ensureDatabase(url.toString()));
  });
});
