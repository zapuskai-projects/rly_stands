import type { Db } from '../db/pool';

export async function loadClockOffsetMs(db: Db): Promise<number> {
  const result = await db.query<{ clock_offset_ms: bigint }>('SELECT clock_offset_ms FROM scenario WHERE id = 1');
  return Number(result.rows[0]?.clock_offset_ms ?? 0n);
}

export async function saveClockOffsetMs(db: Db, offsetMs: number): Promise<void> {
  await db.query('UPDATE scenario SET clock_offset_ms = $1, updated_at = now() WHERE id = 1', [offsetMs]);
}

export async function loadScenarioLabel(db: Db): Promise<string | null> {
  const result = await db.query<{ label: string | null }>('SELECT label FROM scenario WHERE id = 1');
  return result.rows[0]?.label ?? null;
}

export type SbpMode = 'NORMAL' | 'REJECT' | 'TIMEOUT' | 'DOWN';

export async function loadSbpMode(db: Db): Promise<SbpMode> {
  const result = await db.query<{ sbp_mode: SbpMode }>('SELECT sbp_mode FROM scenario WHERE id = 1');
  return result.rows[0]?.sbp_mode ?? 'NORMAL';
}
