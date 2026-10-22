import { BankClock } from '../clock/bank-clock';
import type { Db } from '../db/pool';
import { logger } from '../shared/logger';
import { loadClockOffsetMs, saveClockOffsetMs } from './scenario.repository';

export async function loadBankClock(db: Db): Promise<BankClock> {
  return new BankClock(Date.now, await loadClockOffsetMs(db));
}

export async function shiftBankTime(db: Db, clock: BankClock, target: Date | null): Promise<void> {
  if (target) clock.shiftTo(target);
  else clock.reset();
  await saveClockOffsetMs(db, clock.getOffsetMs());
}

const CLOCK_SYNC_INTERVAL_MS = 2000;

export function startClockSync(db: Db, clock: BankClock, intervalMs = CLOCK_SYNC_INTERVAL_MS): { stop(): void } {
  const timer = setInterval(() => {
    loadClockOffsetMs(db)
      .then((offsetMs) => {
        if (offsetMs !== clock.getOffsetMs()) clock.setOffsetMs(offsetMs);
      })
      .catch((error: unknown) => {
        logger.warn('clock sync failed', { error: error instanceof Error ? error.message : String(error) });
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
