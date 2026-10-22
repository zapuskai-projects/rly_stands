import { Client } from 'pg';

const DATABASE_NAME = /^[A-Za-z0-9_]{1,63}$/;
const MAINTENANCE_DATABASE = 'postgres';
const DUPLICATE_DATABASE = '42P04';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';

export interface DatabaseTarget {
  adminUrl: string;
  database: string;
}

export function splitDatabaseUrl(connectionString: string): DatabaseTarget {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!DATABASE_NAME.test(database)) {
    throw new Error('В адресе базы банка нужно имя базы из латинских букв, цифр и подчёркиваний');
  }
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  return { adminUrl: url.toString(), database };
}

export async function ensureDatabase(connectionString: string): Promise<boolean> {
  const { adminUrl, database } = splitDatabaseUrl(connectionString);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if ((exists.rowCount ?? 0) > 0) return false;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === DUPLICATE_DATABASE || code === UNIQUE_VIOLATION) return false;
      if (code === INSUFFICIENT_PRIVILEGE) throw new Error(`У пользователя PostgreSQL нет права создать базу ${database}: создайте её сами`);
      throw error;
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}
