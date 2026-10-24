export type KeyRow = { table: string; kind: string; column: string; refTable: string | null; refColumn: string | null };

export type TableKeys = { primaryKey: string[]; foreignKeyColumns: string[]; refTables: string[]; keyColumns: string[] };

const uniqueList = (values: string[]) => [...new Set(values)];

export function foreignKeyFacts(rows: KeyRow[], only: string[] | undefined) {
  const wanted = (table: string) => !only?.length || only.includes(table);
  const kept = rows.filter((row) => wanted(row.table));
  const foreignKeys = kept
    .filter((row) => row.kind === 'f')
    .map((row) => ({ table: row.table, column: row.column, refTable: row.refTable ?? '', refColumn: row.refColumn ?? '' }));
  const byTable: Record<string, TableKeys> = {};
  for (const name of uniqueList(kept.map((row) => row.table))) {
    const own = kept.filter((row) => row.table === name);
    const primaryKey = own.filter((row) => row.kind === 'p').map((row) => row.column);
    const foreignKeyColumns = uniqueList(own.filter((row) => row.kind === 'f').map((row) => row.column));
    byTable[name] = {
      primaryKey,
      foreignKeyColumns,
      refTables: uniqueList(own.filter((row) => row.kind === 'f').map((row) => row.refTable ?? '')),
      keyColumns: uniqueList([...primaryKey, ...foreignKeyColumns]),
    };
  }
  return { count: foreignKeys.length, tables: Object.keys(byTable).sort(), foreignKeys, byTable };
}
