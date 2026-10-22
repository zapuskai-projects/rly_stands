import { formatMoney } from '../lib/format';

export function Money({ value, className = '', testId }: { value: number; className?: string; testId?: string }) {
  return (
    <span className={`mono ${className}`.trim()} data-testid={testId}>
      {formatMoney(value)}
    </span>
  );
}
