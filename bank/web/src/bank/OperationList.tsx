import { dateKeyOf, dayLabel } from '../lib/format';
import { bankDateKey } from '../lib/bank-time';
import type { Operation } from '../lib/types';
import { OperationRow } from './OperationRow';

export function OperationList({ operations }: { operations: Operation[] }) {
  const today = bankDateKey();
  const groups: { key: string; items: Operation[] }[] = [];
  for (const operation of operations) {
    const key = dateKeyOf(operation.createdAt);
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(operation);
    else groups.push({ key, items: [operation] });
  }
  return (
    <div data-testid="operation-list">
      {groups.map((group) => (
        <div key={group.key}>
          <div className="ops-day">{dayLabel(group.key, today)}</div>
          {group.items.map((operation) => (
            <OperationRow key={operation.id} operation={operation} />
          ))}
        </div>
      ))}
    </div>
  );
}
