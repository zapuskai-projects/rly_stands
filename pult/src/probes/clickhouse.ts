import { tablesToDrop } from './clickhouse-drop';
import { asArray, asRecord, failure, http, num, str } from './http';
import { executor, type ExecutorTable } from './types';
import { missingFile, richTextProblem } from './work';
import { readWorkFile } from './work-file';

const MODULE = 'ClickHouse';
const BASE = 'http://clickhouse:8123';
const DATABASE = 'student';
const MAX_ROWS = 100;
const HEADERS = { 'X-ClickHouse-User': 'student', 'X-ClickHouse-Key': 'student' };

function endpoint(settings: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    database: DATABASE,
    default_format: 'JSON',
    output_format_json_quote_64bit_integers: '0',
    ...Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, String(value)])),
  });
  return `${BASE}/?${params}`;
}

async function execute(sql: string, settings?: Record<string, string | number>) {
  return http(MODULE, endpoint(settings), { method: 'POST', body: sql, headers: HEADERS });
}

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (quote) {
      current += char;
      if (char === '\\') {
        current += sql[i + 1] ?? '';
        i += 1;
      } else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
    } else if (char === ';') {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const EXCEPTION = /Code: \d+\. DB::Exception: ([^\n"]+)/;

export function queryErrorOf(text: string): string | null {
  const found = EXCEPTION.exec(text);
  if (found?.[1]) return found[1].trim().slice(0, 300);
  const first = text.split('\n').find((row) => row.trim());
  return first ? first.trim().slice(0, 300) : null;
}

async function readRowsIn(sql: string, database: string) {
  const result = await execute(sql.replace(/;\s*$/, ''), { database, readonly: 1, max_execution_time: 10, max_result_rows: 100_000, result_overflow_mode: 'break' });
  if (result.status === 401) throw failure(MODULE, 'доступ', result);
  if (result.status >= 500 && !EXCEPTION.test(result.text)) throw failure(MODULE, 'запрос', result);
  const exception = asRecord(result.json).exception;
  if (!result.ok || (typeof exception === 'string' && exception.trim())) {
    const error = typeof exception === 'string' ? exception : result.text;
    return {
      missingTable: /\bUNKNOWN_TABLE\b|\bCode:\s*60\b/.test(error),
      facts: { database, rowCount: 0, rows: [], columns: [], queryError: queryErrorOf(error) ?? 'запрос не принят' },
    };
  }
  const rows = asArray(asRecord(result.json).data);
  const columns = asArray(asRecord(result.json).meta).map((column) => str(asRecord(column).name));
  return { missingTable: false, facts: { database, rowCount: rows.length, rows: rows.slice(0, MAX_ROWS), columns, queryError: null } };
}

async function readRows(sql: string) {
  const first = await readRowsIn(sql, DATABASE);
  if (!first.missingTable) return first.facts;
  const fallback = await readRowsIn(sql, 'default');
  return fallback.missingTable
    ? { ...first.facts, searchedDatabases: [DATABASE, 'default'] }
    : fallback.facts;
}

async function scalar(sql: string): Promise<unknown> {
  const result = await execute(sql);
  if (!result.ok) throw failure(MODULE, 'чтение', result);
  const row = asRecord(asArray(asRecord(result.json).data)[0]);
  return Object.values(row)[0];
}

const literal = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function ttlOf(createQuery: string): string | null {
  const match = /\bTTL\s+([\s\S]*?)(?=\bSETTINGS\b|$)/.exec(createQuery);
  return match?.[1]?.trim() || null;
}

export const CLICKHOUSE_EXECUTORS: ExecutorTable = {
  'clickhouse.table': executor<{ db?: string; name: string }>(async ({ db, name }) => {
    const databases = db === undefined ? [DATABASE, 'default'] : [db];
    const tables = await execute(
      `SELECT database, engine, sorting_key, partition_key, create_table_query FROM system.tables WHERE database IN (${databases.map(literal).join(', ')}) AND name = ${literal(name)} ORDER BY database = ${literal(DATABASE)} DESC LIMIT 1`,
    );
    if (!tables.ok) throw failure(MODULE, 'чтение таблицы', tables);
    const table = asRecord(asArray(asRecord(tables.json).data)[0]);
    const database = str(table.database) || db || DATABASE;
    if (!Object.keys(table).length) {
      return { exists: false, database, searchedDatabases: databases, name, engine: null, sortingKey: '', partitionKey: '', ttl: null, columns: [], rows: 0 };
    }
    const columns = await execute(
      `SELECT name, type FROM system.columns WHERE database = ${literal(database)} AND table = ${literal(name)} ORDER BY position`,
    );
    if (!columns.ok) throw failure(MODULE, 'чтение колонок', columns);
    const rows = await scalar(`SELECT count() FROM \`${database}\`.\`${name}\``);
    return {
      exists: true,
      database,
      name,
      engine: str(table.engine),
      sortingKey: str(table.sorting_key),
      partitionKey: str(table.partition_key),
      ttl: ttlOf(str(table.create_table_query)),
      columns: asArray(asRecord(columns.json).data).map((row) => ({ name: str(asRecord(row).name), type: str(asRecord(row).type) })),
      rows: num(rows),
    };
  }),

  'clickhouse.query': executor<{ sql: string }>(({ sql }) => readRows(sql)),

  'clickhouse.queryFile': executor<{ file: string }>(async ({ file }, ctx) => {
    const snapshot = readWorkFile(ctx, file);
    const empty = { rowCount: 0, rows: [], columns: [], file: snapshot.file };
    if (snapshot.file.exists && !snapshot.file.isFile) return { ...empty, queryError: `work/${file} — не обычный файл; сохраните SQL в текстовый файл` };
    if (snapshot.text === null) return { ...empty, queryError: missingFile(file, ctx) };
    if (!snapshot.text.trim()) return { ...empty, queryError: `файл work/${file} пуст` };
    const problem = richTextProblem(snapshot.text, file);
    if (problem) return { ...empty, queryError: problem };
    return { ...await readRows(snapshot.text), file: snapshot.file };
  }),

  'clickhouse.sql': executor<{ sql: string }>(async ({ sql }) => {
    for (const statement of splitStatements(sql)) {
      const result = await execute(statement);
      if (!result.ok) throw failure(MODULE, 'выполнение запроса', result);
    }
    return { executed: true };
  }),

  'clickhouse.dropTables': executor<{ tables?: string[]; kafkaTopics?: string[] }>(async ({ tables, kafkaTopics }) => {
    const listed = await execute(
      `SELECT name, engine, engine_full, create_table_query FROM system.tables WHERE database = ${literal(DATABASE)}`,
    );
    if (!listed.ok) throw failure(MODULE, 'чтение списка таблиц', listed);
    const all = asArray(asRecord(listed.json).data).map((row) => ({
      name: str(asRecord(row).name),
      engine: str(asRecord(row).engine),
      engineFull: str(asRecord(row).engine_full),
      createQuery: str(asRecord(row).create_table_query),
    }));
    const dropped = tablesToDrop(all, tables ?? [], kafkaTopics ?? []);
    for (const name of dropped) {
      const result = await execute(`DROP TABLE IF EXISTS \`${DATABASE}\`.\`${name}\` SYNC`);
      if (!result.ok) throw failure(MODULE, `удаление таблицы ${name}`, result);
    }
    return { dropped };
  }),

  'clickhouse.insert': executor<{ table: string; rows: Array<Record<string, unknown>> }>(async ({ table, rows }) => {
    const body = rows.map((row) => JSON.stringify(row)).join('\n');
    const result = await execute(`INSERT INTO ${table} FORMAT JSONEachRow\n${body}`);
    if (!result.ok) throw failure(MODULE, 'вставка строк', result);
    return { inserted: rows.length };
  }),
};

