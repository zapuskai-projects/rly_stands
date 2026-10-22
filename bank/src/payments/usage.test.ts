import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db } from '../db/pool';
import type { DefectCode, DefectSet } from '../defects/catalog';
import { loadPhoneTransferUsage } from './usage';

interface Window {
  from: string;
  to: string;
  route: unknown;
}

function recordingDb(): { db: Db; windows: Window[] } {
  const windows: Window[] = [];
  const db = {
    query: async (_sql: string, values: unknown[]) => {
      windows.push({ from: (values[2] as Date).toISOString(), to: (values[3] as Date).toISOString(), route: values[4] });
      return { rows: [{ total: 0n }] };
    },
  } as unknown as Db;
  return { db, windows };
}

const withUtcDay: DefectSet = new Set<DefectCode>(['daily-limit-utc']);

describe('окна учёта лимита и квоты', () => {
  it('без сбоя сутки и месяц считаются по Москве, в новогоднюю ночь переходят на новый год вместе', async () => {
    const { db, windows } = recordingDb();
    const usage = await loadPhoneTransferUsage(db, 'client', new Date('2026-12-31T21:30:00Z'));
    assert.deepEqual(windows.map(({ from, to, route }) => [from, to, route]), [
      ['2026-12-31T21:00:00.000Z', '2027-01-01T21:00:00.000Z', null],
      ['2026-12-31T21:00:00.000Z', '2027-01-31T21:00:00.000Z', 'SBP'],
    ]);
    assert.equal(usage.dayResetsAt.toISOString(), '2027-01-01T21:00:00.000Z');
    assert.equal(usage.monthResetsAt.toISOString(), '2027-01-31T21:00:00.000Z');
  });

  it('со сбоем «сутки по UTC» в ту же ночь сутки считаются по UTC, а месяц остаётся московским', async () => {
    const { db, windows } = recordingDb();
    const usage = await loadPhoneTransferUsage(db, 'client', new Date('2026-12-31T21:30:00Z'), withUtcDay);
    assert.deepEqual(windows.map(({ from, to, route }) => [from, to, route]), [
      ['2026-12-31T21:00:00.000Z', '2027-01-01T21:00:00.000Z', null],
      ['2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z', null],
      ['2026-12-31T21:00:00.000Z', '2027-01-31T21:00:00.000Z', 'SBP'],
    ]);
    assert.equal(usage.dayResetsAt.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(usage.monthResetsAt.toISOString(), '2027-01-31T21:00:00.000Z');
  });

  it('конец февраля високосного года: квота СБП обнуляется в полночь 1 марта по Москве', async () => {
    const { db, windows } = recordingDb();
    const usage = await loadPhoneTransferUsage(db, 'client', new Date('2028-02-29T12:00:00Z'));
    assert.equal(windows[1]?.from, '2028-01-31T21:00:00.000Z');
    assert.equal(windows[1]?.to, '2028-02-29T21:00:00.000Z');
    assert.equal(usage.monthResetsAt.toISOString(), '2028-02-29T21:00:00.000Z');
  });
});
