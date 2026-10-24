import { moscowDateKey } from '../clock/moscow';
import { LIMIT_COUNTED_STATUSES } from '../payments/status';

export interface TraceStep {
  status: string;
  at: Date;
}

export interface TraceOperation {
  id: string;
  type: string;
  status: string;
  number: string;
  amount: bigint;
  createdAt: Date;
  history: readonly TraceStep[];
}

export interface LimitTrace {
  beforeKop: bigint;
  afterKop: bigint;
}

const COUNTED: ReadonlySet<string> = new Set(LIMIT_COUNTED_STATUSES);

function createdBefore(left: TraceOperation, right: TraceOperation): boolean {
  const delta = left.createdAt.getTime() - right.createdAt.getTime();
  return delta < 0 || (delta === 0 && left.number < right.number);
}

export function statusAt(operation: TraceOperation, moment: Date): string {
  let status = 'CREATED';
  for (const step of operation.history) {
    if (step.at.getTime() <= moment.getTime()) status = step.status;
  }
  return status;
}

export function hadOtherOnReview(operation: TraceOperation, siblings: readonly TraceOperation[]): boolean {
  return siblings.some(
    (other) => other.id !== operation.id && createdBefore(other, operation) && statusAt(other, operation.createdAt) === 'ON_REVIEW',
  );
}

export function limitTrace(operation: TraceOperation, siblings: readonly TraceOperation[], limit: bigint): LimitTrace | null {
  if (operation.type !== 'PHONE_TRANSFER') return null;
  const day = moscowDateKey(operation.createdAt);
  const used = siblings
    .filter((other) => other.type === 'PHONE_TRANSFER' && other.id !== operation.id && createdBefore(other, operation))
    .filter((other) => moscowDateKey(other.createdAt) === day && COUNTED.has(statusAt(other, operation.createdAt)))
    .reduce((sum, other) => sum + other.amount, 0n);
  const beforeKop = limit > used ? limit - used : 0n;
  const keepsLimit = COUNTED.has(operation.status);
  const afterKop = keepsLimit && beforeKop > operation.amount ? beforeKop - operation.amount : keepsLimit ? 0n : beforeKop;
  return { beforeKop, afterKop };
}
