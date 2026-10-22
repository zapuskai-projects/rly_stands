import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { bankNowIso } from '../lib/bank-time';
import { officeApi } from '../lib/api';
import { formatMoney, remainingLabel } from '../lib/format';
import { useAsync, useDocumentTitle, useTick } from '../lib/hooks';
import { REVIEW_STATE_LABEL, reviewSummary } from '../lib/office-labels';
import type { Page, ReviewDetails, ReviewItem } from '../lib/types';
import type { OfficeOutletContext } from './office-context';
import { ReviewCard } from './ReviewCard';

export function ReviewsPage() {
  useDocumentTitle('Ручная проверка · ЗапускБанк');
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState<string | null>(null);
  const { reloadPending } = useOutletContext<OfficeOutletContext>();
  useTick(1000);
  const state = params.get('state') ?? 'PENDING';
  const queue = useAsync(() => officeApi.get<Page<ReviewItem>>('/api/v1/office/reviews', { state: state === 'ALL' ? undefined : state, limit: 50 }), [state], 5000);
  const items = queue.data?.items ?? [];
  const selectedId = params.get('op') ?? items[0]?.operationId ?? null;
  const details = useAsync(
    () => (selectedId ? officeApi.get<ReviewDetails>(`/api/v1/office/reviews/${selectedId}`) : Promise.resolve(null)),
    [selectedId],
    selectedId ? 5000 : undefined,
    (value) => value?.review.state === 'PENDING',
  );

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('op', id);
    setParams(next, { replace: true });
  };
  const changeState = (value: string) => {
    const next = new URLSearchParams();
    if (value !== 'PENDING') next.set('state', value);
    setParams(next, { replace: true });
  };
  const resolved = (message: string) => {
    setToast(message);
    const next = new URLSearchParams(params);
    next.delete('op');
    setParams(next, { replace: true });
    queue.reload();
    details.reload();
    reloadPending();
  };

  return (
    <div className="office-split">
      <section aria-label="Очередь" className="office-panel queue" data-testid="review-queue">
        <div className="queue-head">
          <h1>{state === 'PENDING' ? 'Ждут решения' : 'Проверки'}</h1>
          <select className="input" style={{ width: 'auto', minHeight: 36, padding: '4px 8px' }} value={state} onChange={(event) => changeState(event.target.value)} aria-label="Состояние проверок" data-testid="queue-state">
            <option value="PENDING">по сроку ответа</option>
            <option value="APPROVED">{REVIEW_STATE_LABEL.APPROVED}</option>
            <option value="REJECTED">{REVIEW_STATE_LABEL.REJECTED}</option>
            <option value="EXPIRED">{REVIEW_STATE_LABEL.EXPIRED}</option>
            <option value="ALL">все</option>
          </select>
        </div>
        {queue.data ? (
          items.length > 0 ? (
            items.map((review) => (
              <Link
                key={review.operationId}
                to={`/office?${new URLSearchParams({ ...(state !== 'PENDING' ? { state } : {}), op: review.operationId }).toString()}`}
                className={`queue-item${review.operationId === selectedId ? ' selected' : ''}`}
                onClick={(event) => {
                  event.preventDefault();
                  select(review.operationId);
                }}
                data-testid="queue-item"
                data-operation-number={review.operationNumber}
              >
                <div className="queue-line">
                  <span className="mono" style={{ fontSize: 12.5 }}>{review.operationNumber}</span>
                  <span className={review.state === 'PENDING' ? 'timer-warn' : 'mono muted'}>
                    {review.state === 'PENDING' ? remainingLabel(review.deadlineAt, bankNowIso()) : REVIEW_STATE_LABEL[review.state]}
                  </span>
                </div>
                <div className="queue-line">
                  <span style={{ fontWeight: 600 }}>{review.clientName}</span>
                  <span className="mono" style={{ fontWeight: 600 }}>{formatMoney(review.amount)}</span>
                </div>
                <div className="muted" style={{ fontSize: 13 }}>{reviewSummary(review.score, review.rules.map((rule) => rule.code))}</div>
              </Link>
            ))
          ) : (
            <div className="state" data-testid="queue-empty">
              {state === 'PENDING' ? 'Очередь пуста: все переводы разобраны' : 'Таких проверок нет'}
            </div>
          )
        ) : queue.error ? (
          <ErrorBox error={queue.error} onRetry={queue.reload} />
        ) : (
          <Loading />
        )}
      </section>
      {selectedId ? (
        details.data ? (
          <ReviewCard details={details.data} onResolved={resolved} />
        ) : details.error ? (
          <div className="review-column">
            <ErrorBox error={details.error} onRetry={details.reload} />
          </div>
        ) : (
          <div className="review-column office-panel">
            <Loading rows={5} />
          </div>
        )
      ) : (
        <div className="review-column office-panel state" data-testid="no-selection">
          {queue.data ? 'Выберите перевод в очереди слева' : ''}
        </div>
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
