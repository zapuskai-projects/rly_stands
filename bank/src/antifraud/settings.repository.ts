import type { Db } from '../db/pool';
import type { Thresholds } from './scoring';

export async function loadThresholds(db: Db): Promise<Thresholds> {
  const result = await db.query<{ review_threshold: number; reject_threshold: number }>(
    'SELECT review_threshold, reject_threshold FROM antifraud_settings WHERE id = 1',
  );
  const row = result.rows[0];
  return { review: row?.review_threshold ?? 70, reject: row?.reject_threshold ?? 90 };
}
