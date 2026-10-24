import { moscowDateKey, moscowParts } from '../clock/moscow';

export const RUN_HOUR = 10;
export const REMINDER_HOUR = 18;
export const MAX_ATTEMPTS = 3;
export const MAX_DAY_OF_MONTH = 28;

const RETRYABLE_REASONS: readonly string[] = ['INSUFFICIENT_FUNDS', 'DAILY_LIMIT_EXCEEDED'];
const DAY_MS = 24 * 60 * 60 * 1000;

export type AutopaymentStatus = 'ACTIVE' | 'PAUSED' | 'FAILED' | 'FINISHED';

function utcOf(dateKey: string): Date {
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function keyOf(instant: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
}

export function addDays(dateKey: string, days: number): string {
  return keyOf(new Date(utcOf(dateKey).getTime() + days * DAY_MS));
}

export function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && keyOf(utcOf(value)) === value;
}

export function nextOccurrence(dayOfMonth: number, afterKey: string): string {
  const after = utcOf(afterKey);
  const sameMonth = after.getUTCDate() < dayOfMonth;
  const month = after.getUTCMonth() + (sameMonth ? 0 : 1);
  return keyOf(new Date(Date.UTC(after.getUTCFullYear(), month, dayOfMonth)));
}

export function firstRunDate(now: Date, dayOfMonth: number): string {
  const { day, hour } = moscowParts(now);
  const today = moscowDateKey(now);
  return day === dayOfMonth && hour < RUN_HOUR ? today : nextOccurrence(dayOfMonth, today);
}

export function isDue(now: Date, runOn: string): boolean {
  const today = moscowDateKey(now);
  return runOn < today || (runOn === today && moscowParts(now).hour >= RUN_HOUR);
}

export function reminderHourReached(now: Date): boolean {
  return moscowParts(now).hour >= REMINDER_HOUR;
}

export function isReminderDue(now: Date, runOn: string): boolean {
  return runOn === addDays(moscowDateKey(now), 1) && reminderHourReached(now);
}

export function nextCycleDate(dayOfMonth: number, cycleDate: string, now: Date, endsOn: string | null): string | null {
  const today = moscowDateKey(now);
  const next = nextOccurrence(dayOfMonth, cycleDate > today ? cycleDate : today);
  return endsOn !== null && next > endsOn ? null : next;
}

export function runKey(autopaymentId: string, cycleDate: string, attempt: number, series = 1): string {
  return `autopay:${autopaymentId}:${cycleDate}:${attempt}${series > 1 ? `:s${series}` : ''}`;
}

export type FailureDecision = 'RETRY' | 'FAIL';

export function decideAfterFailure(reasonCode: string, attempt: number, noRetryOnFunds = false): FailureDecision {
  if (noRetryOnFunds && reasonCode === 'INSUFFICIENT_FUNDS') return 'FAIL';
  return RETRYABLE_REASONS.includes(reasonCode) && attempt < MAX_ATTEMPTS ? 'RETRY' : 'FAIL';
}
