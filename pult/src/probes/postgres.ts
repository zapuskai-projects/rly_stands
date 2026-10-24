import { Client } from 'pg';
import { ProbeError, errorText } from './errors';
import { foreignKeyFacts, type KeyRow } from './postgres-keys';
import { executor, type ExecutorTable } from './types';

const MODULE = 'PostgreSQL';
const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 8000;
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

type Database = 'student' | 'bank';

function newClient(database: Database = 'student'): Client {
  return new Client({
    host: 'postgres',
    port: 5432,
    user: 'student',
    password: 'student',
    database,
    connectionTimeoutMillis: 5000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
}

const QUERY_CANCELED = '57014';

export function isOutage(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code === QUERY_CANCELED) return false;
  return CONNECTION_CODES.has(code) || code.startsWith('08') || code.startsWith('57');
}

async function withClient<T>(work: (client: Client) => Promise<T>, database?: Database): Promise<T> {
  const client = newClient(database);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw new ProbeError(`${MODULE} не отвечает: ${errorText(error)}`);
  }
  try {
    return await work(client);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (isOutage(error)) throw new ProbeError(`${MODULE} не отвечает: ${errorText(error)}`);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const COLUMNS_SQL = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
         pg_get_expr(d.adbin, d.adrelid) AS "default"
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

const CONSTRAINTS_SQL = `
  SELECT con.contype AS kind,
         (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS columns,
         ref.relname AS ref_table,
         (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS ref_columns
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class ref ON ref.oid = con.confrelid
  WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('p', 'f')`;

const INDEXES_SQL = `
  SELECT i.relname AS name, ix.indisunique AS "unique",
         (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum) AS columns
  FROM pg_index ix
  JOIN pg_class c ON c.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND NOT ix.indisprimary`;

const SCHEMA_KEYS_SQL = `
  SELECT c.relname AS "table", con.contype AS kind, att.attname AS "column", ref.relname AS "refTable", refatt.attname AS "refColumn"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class ref ON ref.oid = con.confrelid
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
  LEFT JOIN pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = con.confkey[k.ord]
  WHERE n.nspname = $1 AND con.contype IN ('p', 'f')
  ORDER BY c.relname, con.conname, k.ord`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const TRANSACTION_CONTROL = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release', 'prepare']);

export function transactionControl(sql: string): string | null {
  const statements = sql.replace(/'(?:[^']|'')*'/g, "''").split(';');
  for (const statement of statements) {
    const word = /^\s*([A-Za-z]+)/.exec(statement)?.[1]?.toLowerCase();
    if (word && TRANSACTION_CONTROL.has(word)) return word.toUpperCase();
  }
  return null;
}

type TxFacts = { failed: boolean; error: string | null; code: string | null; constraint: string | null; rowCount: number; rows: unknown[] };

export function txFailure(error: unknown): TxFacts {
  const details = error as { code?: unknown; constraint?: unknown };
  return {
    failed: true,
    error: errorText(error),
    code: typeof details.code === 'string' ? details.code : null,
    constraint: typeof details.constraint === 'string' ? details.constraint : null,
    rowCount: 0,
    rows: [],
  };
}

export const POSTGRES_EXECUTORS: ExecutorTable = {
  'postgres.table': executor<{ schema?: string; name: string }>(({ schema, name }) =>
    withClient(async (client) => {
      const space = schema ?? 'public';
      const columns = await client.query(COLUMNS_SQL, [space, name]);
      if (!columns.rowCount) {
        return { exists: false, columns: [], primaryKey: [], foreignKeys: [], indexes: [], uniqueKeys: [], rows: 0 };
      }
      const constraints = await client.query(CONSTRAINTS_SQL, [space, name]);
      const indexes = await client.query(INDEXES_SQL, [space, name]);
      const count = await client.query(`SELECT count(*)::int AS rows FROM ${quoteIdent(space)}.${quoteIdent(name)}`);
      return {
        exists: true,
        columns: columns.rows.map((row) => ({ name: row.name, type: row.type, nullable: row.nullable, default: row.default })),
        primaryKey: constraints.rows.find((row) => row.kind === 'p')?.columns ?? [],
        foreignKeys: constraints.rows
          .filter((row) => row.kind === 'f')
          .map((row) => ({ columns: row.columns, refTable: row.ref_table, refColumns: row.ref_columns })),
        indexes: indexes.rows.map((row) => ({ name: row.name, columns: row.columns, unique: row.unique })),
        uniqueKeys: indexes.rows.filter((row) => row.unique).map((row) => row.columns),
        rows: count.rows[0]?.rows ?? 0,
      };
    }),
  ),

  'postgres.foreignKeys': executor<{ database?: Database; schema?: string; tables?: string[] }>(({ database, schema, tables }) =>
    withClient(async (client) => {
      const result = await client.query<KeyRow>(SCHEMA_KEYS_SQL, [schema ?? 'public']);
      return foreignKeyFacts(result.rows, tables);
    }, database),
  ),

  'postgres.query': executor<{ sql: string }>(({ sql }) =>
    withClient(async (client) => {
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query(sql);
        const rows = Array.isArray(result.rows) ? result.rows : [];
        return { rowCount: rows.length, rows: rows.slice(0, MAX_ROWS), queryError: null };
      } catch (error) {
        if (isOutage(error)) throw error;
        return { rowCount: 0, rows: [], queryError: errorText(error) };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    }),
  ),

  'postgres.tx': executor<{ sql: string }>(({ sql }) => {
    const control = transactionControl(sql);
    if (control) throw new ProbeError(`${MODULE}: в проверке нельзя управлять транзакцией (${control}): она всегда откатывается`);
    return withClient(async (client) => {
      try {
        await client.query('BEGIN');
        const result = await client.query(sql);
        const last = Array.isArray(result) ? result.at(-1) : result;
        const rows = Array.isArray(last?.rows) ? last.rows : [];
        return { failed: false, error: null, code: null, constraint: null, rowCount: rows.length, rows: rows.slice(0, MAX_ROWS) };
      } catch (error) {
        if (isOutage(error)) throw error;
        return txFailure(error);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    });
  }),

  'postgres.sql': executor<{ sql: string; database?: Database }>(({ sql, database }) =>
    withClient(async (client) => {
      try {
        await client.query(sql);
      } catch (error) {
        throw new ProbeError(`${MODULE}: ${errorText(error)}`);
      }
      return { executed: true };
    }, database),
  ),
};
