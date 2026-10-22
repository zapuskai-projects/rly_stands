import { Link } from 'react-router-dom';
import { Money } from '../components/Money';
import { Pill } from '../components/StatusPill';
import { dayAndTime } from '../lib/format';
import { recipientLabel } from '../lib/office-labels';
import { STATUS_LABEL, statusTone } from '../lib/status';
import type { OfficeOperationRow } from '../lib/types';

export function OfficeOperationTable({ rows, showClient = true }: { rows: OfficeOperationRow[]; showClient?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table" data-testid="operations-table">
        <thead>
          <tr>
            <th>Когда</th>
            <th>Номер</th>
            {showClient ? <th>Клиент</th> : null}
            <th>Кому</th>
            <th style={{ textAlign: 'right' }}>Сумма</th>
            <th style={{ textAlign: 'right' }}>Комиссия</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="operation-row" data-operation-number={row.number}>
              <td className="mono" style={{ fontSize: 13 }}>{dayAndTime(row.createdAt)}</td>
              <td>
                <Link to={`/office/operations/${row.id}`} className="mono" data-testid="operation-link">
                  {row.number}
                </Link>
              </td>
              {showClient ? <td>{row.clientName}</td> : null}
              <td>{recipientLabel(row)}</td>
              <td style={{ textAlign: 'right' }}><Money value={row.amount} /></td>
              <td style={{ textAlign: 'right' }}><Money value={row.fee} /></td>
              <td><Pill tone={statusTone(row.status)}>{STATUS_LABEL[row.status]}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
