import { STATUS_LABEL, statusTone, type Tone } from '../lib/status';
import type { OperationStatus } from '../lib/types';

export function Pill({ tone, children, testId }: { tone: Tone; children: React.ReactNode; testId?: string }) {
  return (
    <span className={`pill pill-${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: OperationStatus }) {
  return (
    <Pill tone={statusTone(status)} testId="operation-status">
      {STATUS_LABEL[status]}
    </Pill>
  );
}
