import type { Db } from '../db/pool';
import { isDefectCode, parseDefectCodes, type DefectCode, type DefectMark, type DefectSet } from './catalog';

export interface DefectMarkRecord {
  operationId: string;
  code: DefectCode;
  createdAt: Date;
  details: Record<string, unknown>;
}

export async function loadActiveDefects(db: Db): Promise<DefectSet> {
  const result = await db.query<{ defects: string[] }>('SELECT defects FROM scenario WHERE id = 1');
  return parseDefectCodes(result.rows[0]?.defects ?? []);
}

export async function saveActiveDefects(db: Db, codes: readonly string[]): Promise<void> {
  const unknown = codes.filter((code) => !isDefectCode(code));
  if (unknown.length > 0) throw new RangeError(`Неизвестные коды: ${unknown.join(', ')}`);
  await db.query('UPDATE scenario SET defects = $1::text[], updated_at = now() WHERE id = 1', [[...new Set(codes)]]);
}

export async function insertDefectMarks(db: Db, operationId: string, marks: readonly DefectMark[], at: Date): Promise<void> {
  for (const mark of marks) {
    await db.query(
      `INSERT INTO defect_marks (operation_id, defect_code, created_at, details) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (operation_id, defect_code) DO NOTHING`,
      [operationId, mark.code, at, JSON.stringify(mark.details)],
    );
  }
}

export async function hasDefectMark(db: Db, operationId: string, code: DefectCode): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM defect_marks WHERE operation_id = $1 AND defect_code = $2', [operationId, code]);
  return (result.rowCount ?? 0) > 0;
}

export async function listDefectMarks(db: Db, operationId: string): Promise<DefectMarkRecord[]> {
  const result = await db.query<{ operation_id: string; defect_code: DefectCode; created_at: Date; details: Record<string, unknown> }>(
    'SELECT operation_id, defect_code, created_at, details FROM defect_marks WHERE operation_id = $1 ORDER BY id',
    [operationId],
  );
  return result.rows.map((row) => ({ operationId: row.operation_id, code: row.defect_code, createdAt: row.created_at, details: row.details }));
}
