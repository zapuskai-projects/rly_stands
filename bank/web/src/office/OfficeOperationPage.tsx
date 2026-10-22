import { Link, useParams } from 'react-router-dom';
import { Pill, StatusPill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { officeApi } from '../lib/api';
import { dayAndTime, formatAccountNumber, formatMoney, timeWithSeconds } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { REVIEW_STATE_LABEL, channelLabel, recipientLabel } from '../lib/office-labels';
import { STATUS_LABEL } from '../lib/status';
import { buildTimeline } from '../lib/timeline';
import type { OfficeOperation } from '../lib/types';

export function OfficeOperationPage() {
  const { id = '' } = useParams();
  const state = useAsync(() => officeApi.get<OfficeOperation>(`/api/v1/office/operations/${id}`), [id], 4000);
  const data = state.data;
  useDocumentTitle(data ? `Операция ${data.operation.number} · ЗапускБанк` : 'Операция · ЗапускБанк');

  if (!data) {
    return <div className="office-panel">{state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : <Loading rows={5} />}</div>;
  }
  const { operation, client, antifraud, review } = data;
  return (
    <div className="stack gap-16" data-testid="office-operation">
      <div className="office-panel review-head">
        <div className="stack gap-4">
          <span className="mono muted">{operation.number} · {channelLabel(operation)}</span>
          <h1 className="review-amount" data-testid="office-operation-amount">{formatMoney(operation.amount)}</h1>
          <span>{client.fullName} → {recipientLabel({ type: operation.type, recipient: operation.recipient })}</span>
        </div>
        <div className="stack gap-4" style={{ alignItems: 'flex-end' }}>
          <StatusPill status={operation.status} />
          <span className="muted">Комиссия {formatMoney(operation.fee)} · клиент {client.number}</span>
        </div>
      </div>
      <div className="review-grid">
        <section className="office-panel office-block" aria-label="Ход операции" data-testid="office-timeline">
          <h3>Ход операции</h3>
          {buildTimeline(operation).map((step) => (
            <div key={step.key} className="rule-row" data-testid="timeline-step" data-step={step.key} data-state={step.state}>
              <span>{step.label}</span>
              <span className="mono muted">{step.at ? timeWithSeconds(step.at) : '—'}</span>
            </div>
          ))}
        </section>
        <section className="office-panel office-block" aria-label="История статусов" data-testid="status-history">
          <h3>История статусов</h3>
          {operation.statusHistory.map((item, index) => (
            <div key={`${item.status}-${index}`} className="rule-row" data-testid="history-row">
              <span>
                {STATUS_LABEL[item.status]}
                {item.reasonCode ? <span className="mono muted"> · {item.reasonCode}</span> : null}
              </span>
              <span className="mono muted">{dayAndTime(item.at)}</span>
            </div>
          ))}
        </section>
      </div>
      <div className="review-grid">
        <section className="office-panel office-block" aria-label="Антифрод" data-testid="office-antifraud">
          <h3>Антифрод</h3>
          {antifraud ? (
            <>
              <div className="row between">
                <span className="muted">Решение: {antifraud.decision === 'APPROVE' ? 'пропустить' : antifraud.decision === 'REVIEW' ? 'на проверку' : 'отклонить'}</span>
                <span className="score"><strong>{antifraud.score}</strong> / 100 · пороги {antifraud.thresholds.review} и {antifraud.thresholds.reject}</span>
              </div>
              {antifraud.rules.map((rule) => (
                <div key={rule.code} className="rule-row"><span>{rule.description}</span><span className="mono">+{rule.points}</span></div>
              ))}
              {antifraud.rules.length === 0 ? <span className="muted">Правила не сработали</span> : null}
            </>
          ) : (
            <span className="muted">Оценки нет: перевод не проходил через антифрод</span>
          )}
        </section>
        <section className="office-panel office-block" aria-label="Ручная проверка" data-testid="office-review">
          <h3>Ручная проверка</h3>
          {review ? (
            <>
              <div className="row gap-8"><Pill tone={review.state === 'APPROVED' ? 'ok' : review.state === 'PENDING' ? 'warn' : 'bad'}>{REVIEW_STATE_LABEL[review.state]}</Pill>{review.resolvedBy ? <span className="muted">{review.resolvedBy}</span> : null}</div>
              {review.comment ? <p>{review.comment}</p> : null}
              {review.state === 'PENDING' ? <Link to={`/office?op=${review.operationId}`} data-testid="open-review">Открыть в очереди</Link> : null}
            </>
          ) : (
            <span className="muted">Ручной проверки не было</span>
          )}
          <dl className="dl" style={{ marginTop: 8 }}>
            <div><dt>Клиент</dt><dd>{client.fullName}</dd></div>
            <div><dt>Со счёта</dt><dd className="mono" style={{ fontSize: 13 }}>{formatAccountNumber(operation.fromAccount.number)}</dd></div>
            {operation.rejection ? <div><dt>Причина отказа</dt><dd>{operation.rejection.message}</dd></div> : null}
          </dl>
        </section>
      </div>
    </div>
  );
}

