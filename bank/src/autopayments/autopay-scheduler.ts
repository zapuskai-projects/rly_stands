import { moscowDateKey } from '../clock/moscow';
import { withTransaction } from '../db/pool';
import { loadContact, queuePair } from '../notifications/queue';
import type { ReleaseSource } from '../release/release-source';
import { loadScenarioLabel } from '../scenario/scenario.repository';
import { logger } from '../shared/logger';
import { reminderTexts } from './autopay-texts';
import { advanceRun, startAttempt, type RunnerDeps } from './autopay-runner';
import {
  listDueAutopaymentIds,
  listPendingRunIds,
  listReminderCandidates,
  lockAutopayment,
  setAutopaymentState,
} from './autopayments.repository';
import { finishExpiredAutopayments } from './autopayments.service';
import { addDays, reminderHourReached } from './schedule';

const BATCH = 50;

export interface CycleReport {
  started: number;
  advanced: number;
  reminded: number;
  finished: number;
}

async function sendReminders(deps: RunnerDeps, now: Date): Promise<number> {
  if (!reminderHourReached(now)) return 0;
  const candidates = await listReminderCandidates(deps.pool, addDays(moscowDateKey(now), 1));
  let sent = 0;
  for (const candidate of candidates) {
    const done = await withTransaction(deps.pool, async (tx) => {
      const current = await lockAutopayment(tx, candidate.id);
      if (!current || current.status !== 'ACTIVE' || current.attempt !== 0 || current.nextRunOn === null || current.remindedFor === current.nextRunOn) return false;
      const contact = await loadContact(tx, current.clientId);
      if (contact) {
        await queuePair(tx, {
          operationId: null,
          autopaymentId: current.id,
          requestId: `autopay-reminder-${current.id.slice(0, 8)}`,
          contact,
          kind: 'AUTOPAYMENT_REMINDER',
          texts: reminderTexts({ name: current.templateName, amount: current.amount }, current.nextRunOn),
          at: now,
        });
      }
      await setAutopaymentState(tx, current.id, { remindedFor: current.nextRunOn }, now);
      return true;
    });
    if (done) sent += 1;
  }
  return sent;
}

export async function runAutopaymentCycle(deps: RunnerDeps, releases: ReleaseSource): Promise<CycleReport> {
  const report: CycleReport = { started: 0, advanced: 0, reminded: 0, finished: 0 };
  if (!(await releases.atLeast('1.1'))) return report;
  const now = deps.clock.now();
  for (const id of await listDueAutopaymentIds(deps.pool, moscowDateKey(now), BATCH)) {
    try {
      if (await startAttempt(deps, id, 'SCHEDULE')) report.started += 1;
    } catch (error) {
      logger.warn('autopayment attempt not started', { autopaymentId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  report.finished = await finishExpiredAutopayments(deps);
  const label = await loadScenarioLabel(deps.pool);
  for (const runId of await listPendingRunIds(deps.pool, BATCH)) {
    try {
      await advanceRun(deps, runId, { requestId: `autopay-${runId.slice(0, 8)}`, attemptLabel: label });
      report.advanced += 1;
    } catch (error) {
      logger.warn('autopayment run failed', { runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  report.reminded = await sendReminders(deps, now);
  return report;
}

const CYCLE_INTERVAL_MS = 2000;

export function startAutopayScheduler(deps: RunnerDeps, releases: ReleaseSource, intervalMs = CYCLE_INTERVAL_MS): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runAutopaymentCycle(deps, releases)
      .catch((error: unknown) => {
        logger.warn('autopayment cycle failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
