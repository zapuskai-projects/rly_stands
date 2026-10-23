import { tablesToDrop } from './clickhouse-drop';
import { asArray, asRecord, failure, http, num, str } from './http';
import { executor, type ExecutorTable } from './types';
import { readWorkText } from './work';

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

async function readRows(sql: string) {
  const result = await execute(sql.replace(/;\s*$/, ''), { readonly: 1, max_execution_time: 10, max_result_rows: 100_000, result_overflow_mode: 'break' });
  if (result.status >= 500 && !EXCEPTION.test(result.text)) throw failure(MODULE, 'запрос', result);
  if (!result.ok) {
    return { rowCount: 0, rows: [], queryError: queryErrorOf(result.text) ?? 'запрос не принят' };
  }
  const rows = asArray(asRecord(result.json).data);
  return { rowCount: rows.length, rows: rows.slice(0, MAX_ROWS), queryError: null };
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
    const database = db ?? DATABASE;
    const tables = await execute(
      `SELECT engine, sorting_key, partition_key, create_table_query FROM system.tables WHERE database = ${literal(database)} AND name = ${literal(name)}`,
    );
    if (!tables.ok) throw failure(MODULE, 'чтение таблицы', tables);
    const table = asRecord(asArray(asRecord(tables.json).data)[0]);
    if (!Object.keys(table).length) {
      return { exists: false, engine: null, sortingKey: '', partitionKey: '', ttl: null, columns: [], rows: 0 };
    }
    const columns = await execute(
      `SELECT name, type FROM system.columns WHERE database = ${literal(database)} AND table = ${literal(name)} ORDER BY position`,
    );
    const rows = await scalar(`SELECT count() FROM \`${database}\`.\`${name}\``);
    return {
      exists: true,
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
    const text = readWorkText(ctx, file);
    if (text === null) return { rowCount: 0, rows: [], queryError: `файла work/${file} нет` };
    if (!text.trim()) return { rowCount: 0, rows: [], queryError: `файл work/${file} пуст` };
    return readRows(text);
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

