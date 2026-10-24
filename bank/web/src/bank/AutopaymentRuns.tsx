import { Link } from 'react-router-dom';
import { Pill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { clientApi } from '../lib/api';
import { dateLabel, failureLabel, RUN_OUTCOME_LABEL, RUN_OUTCOME_TONE } from '../lib/autopay-labels';
import { formatMoney } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { AutopaymentRun } from '../lib/types';

export function RunsTable({ runs, operationHref }: { runs: AutopaymentRun[]; operationHref: (id: string) => string }) {
  return (
    <div className="table-wrap">
      <table className="table" data-testid="runs-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Попытка</th>
            <th>Итог</th>
            <th style={{ textAlign: 'right' }}>Сумма</th>
            <th>Операция</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} data-testid="run-row" data-run-outcome={run.outcome}>
              <td>{dateLabel(run.runDate)}</td>
              <td>{run.attempt} из 3</td>
              <td>
                <Pill tone={RUN_OUTCOME_TONE[run.outcome]}>{RUN_OUTCOME_LABEL[run.outcome]}</Pill>
                {run.reasonCode ? <div className="muted" style={{ fontSize: 13 }}>{failureLabel(run.reasonCode)}</div> : null}
              </td>
              <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(run.amount)}</td>
              <td>
                {run.operationId ? (
                  <Link to={operationHref(run.operationId)} className="mono" data-testid="run-operation">
                    {run.operationNumber}
                  </Link>
                ) : (
                  <span className="muted">нет</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AutopaymentRuns({ autopaymentId }: { autopaymentId: string }) {
  const state = useAsync(() => clientApi.get<{ items: AutopaymentRun[] }>(`/api/v1/autopayments/${autopaymentId}/runs`), [autopaymentId], 4000);
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading rows={2} />;
  if (state.data.items.length === 0) {
    return (
      <p className="muted" data-testid="runs-empty">
        Запусков пока не было. Первый будет в день платежа в 10:00.
      </p>
    );
  }
  return <RunsTable runs={state.data.items} operationHref={(id) => `/operations/${id}`} />;
}
