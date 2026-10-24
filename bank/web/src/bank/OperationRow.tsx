import { Link } from 'react-router-dom';
import { Avatar, avatarToneFor } from '../components/Avatar';
import { formatPhone, formatSignedMoney, timeOf } from '../lib/format';
import { STATUS_LABEL, statusTone } from '../lib/status';
import type { Operation } from '../lib/types';

export function recipientTitle(operation: Operation): string {
  if (operation.type === 'OWN_TRANSFER') return 'Между своими счетами';
  if (operation.type === 'QR_PAYMENT') return `${operation.recipient.displayName ?? 'Магазин'} · оплата по QR`;
  if (operation.type === 'QR_REFUND') return `${operation.recipient.displayName ?? 'Покупатель'} · возврат по QR`;
  const who = operation.recipient.displayName ?? (operation.recipient.phone ? formatPhone(operation.recipient.phone) : 'Получатель');
  return `${who} · по номеру телефона`;
}

export function OperationRow({ operation }: { operation: Operation }) {
  const tone = statusTone(operation.status);
  const subClass = tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : '';
  const label = operation.status === 'COMPLETED' ? 'Выполнен' : STATUS_LABEL[operation.status];
  const name = operation.type === 'OWN_TRANSFER' ? 'Свои счета' : (operation.recipient.displayName ?? operation.recipient.phone ?? 'Получатель');
  return (
    <Link to={`/operations/${operation.id}`} className="op" data-testid="operation-row" data-operation-number={operation.number}>
      <Avatar name={name} tone={avatarToneFor(operation.status)} />
      <div className="op-body">
        <div className="op-title">{recipientTitle(operation)}</div>
        <div className={`op-sub ${subClass}`.trim()}>
          {label} · {timeOf(operation.createdAt)}
        </div>
      </div>
      <div className="op-amount">{formatSignedMoney(operation.total, 'out')}</div>
    </Link>
  );
}
