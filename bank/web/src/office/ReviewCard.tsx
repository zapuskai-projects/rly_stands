import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Pill, StatusPill } from '../components/StatusPill';
import { Money } from '../components/Money';
import { bankNowIso } from '../lib/bank-time';
import { ApiError, explain, officeApi } from '../lib/api';
import { dayAndTime, fullDate, formatAccountNumber, formatMoney, remainingLabel, timeOf } from '../lib/format';
import { CLIENT_KIND_LABEL, REVIEW_STATE_LABEL, channelLabel, recipientLabel } from '../lib/office-labels';
import { STATUS_LABEL } from '../lib/status';
import type { ReviewDetails, ReviewItem } from '../lib/types';

function useBankNow(): string {
  const [now, setNow] = useState(bankNowIso());
  useEffect(() => {
    const timer = setInterval(() => setNow(bankNowIso()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function monthYear(iso: string): string {
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

function Deadline({ review }: { review: ReviewItem }) {
  const now = useBankNow();
  if (review.state !== 'PENDING') return <span className="muted">{REVIEW_STATE_LABEL[review.state]}</span>;
  const left = remainingLabel(review.deadlineAt, now);
  return (
    <span className="muted" data-testid="review-deadline">
      Ответить до {timeOf(review.deadlineAt)} · осталось <span className="timer-warn">{left}</span>
    </span>
  );
}

export function ReviewCard({ details, onResolved }: { details: ReviewDetails; onResolved: (message: string) => void }) {
  const { review, client, thresholds, recentOperations } = details;
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    setComment('');
    setError(null);
  }, [review.operationId]);

  const act = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && comment.trim().length < 3) {
      setError('Для отказа напишите комментарий не короче трёх символов');
      return;
    }
    setBusy(action);
    setError(null);
    try {
      await officeApi.post<ReviewItem>(`/api/v1/office/reviews/${review.operationId}/${action}`, comment.trim() ? { comment: comment.trim() } : undefined);
      onResolved(action === 'approve' ? 'Перевод одобрен' : 'Перевод отклонён, деньги разморожены');
    } catch (caught) {
      setError(explain(caught));
      if (caught instanceof ApiError && caught.status === 409) onResolved(caught.message);
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void act('approve');
  };

  return (
    <section aria-label="Карточка перевода" className="review-column" data-testid="review-card">
      <div className="office-panel review-head">
        <div className="stack gap-4">
          <span className="mono muted" data-testid="review-number">
            {review.operationNumber} · {channelLabel(review)}
          </span>
          <h2 className="review-amount" data-testid="review-amount">
            {formatMoney(review.amount)}
          </h2>
          <span>
            {client.fullName} → {recipientLabel({ type: review.type, recipient: review.recipient })}
          </span>
        </div>
        <div className="stack gap-4" style={{ alignItems: 'flex-end' }}>
          {review.state === 'PENDING' ? <StatusPill status="ON_REVIEW" /> : <Pill tone={review.state === 'APPROVED' ? 'ok' : 'bad'}>{REVIEW_STATE_LABEL[review.state]}</Pill>}
          <Deadline review={review} />
        </div>
      </div>

      <div className="review-grid">
        <div className="office-panel office-block" data-testid="antifraud-block">
          <div className="row between">
            <h3>Антифрод</h3>
            <span className="score">
              <strong data-testid="antifraud-score">{review.score}</strong> / 100 · порог {thresholds.review}
            </span>
          </div>
          {review.rules.map((rule) => (
            <div key={rule.code} className="rule-row" data-testid="antifraud-rule" data-rule={rule.code}>
              <span>{rule.description}</span>
              <span className="mono">+{rule.points}</span>
            </div>
          ))}
          {review.rules.length === 0 ? <span className="muted">Правила не сработали</span> : null}
        </div>
        <div className="office-panel office-block" data-testid="client-block">
          <h3>Клиент</h3>
          <dl className="dl">
            <div>
              <dt>Персона</dt>
              <dd>{CLIENT_KIND_LABEL[client.kind]}</dd>
            </div>
            <div>
              <dt>Клиент банка</dt>
              <dd>с {monthYear(client.customerSince)}</dd>
            </div>
            <div>
              <dt>Обычный перевод</dt>
              <dd className="mono" data-testid="usual-amount">{client.usualAmount === null ? 'переводов не было' : `≈ ${formatMoney(client.usualAmount)}`}</dd>
            </div>
            <div>
              <dt>Тариф</dt>
              <dd>{client.tariffName}</dd>
            </div>
            <div>
              <dt>Счёт</dt>
              <dd className="mono" style={{ fontSize: 13 }}>{formatAccountNumber(client.accountNumber)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="office-panel office-block" data-testid="recent-operations">
        <h3>Последние операции клиента</h3>
        <div className="table-wrap">
          <div className="office-table-row head">
            <span>Когда</span>
            <span>Кому</span>
            <span>Сумма</span>
            <span className="col-status">Статус</span>
          </div>
          {recentOperations.map((row) => (
            <div key={row.id} className="office-table-row" data-testid="recent-operation">
              <span className="mono" style={{ fontSize: 13 }}>{dayAndTime(row.createdAt)}</span>
              <Link to={`/office/operations/${row.id}`} data-testid="recent-operation-link">{recentRecipient(row)}</Link>
              <Money value={row.amount} />
              <span className={`col-status status-text-${row.status === 'COMPLETED' ? 'ok' : row.status === 'REJECTED' || row.status === 'FAILED' ? 'bad' : 'warn'}`}>{STATUS_LABEL[row.status]}</span>
            </div>
          ))}
          {recentOperations.length === 0 ? <span className="muted">Других операций нет</span> : null}
        </div>
      </div>

      {review.state === 'PENDING' ? (
        <form className="office-panel decision-form" onSubmit={submit} data-testid="decision-form">
          <label htmlFor="review-comment" style={{ fontWeight: 700 }}>
            Комментарий к решению
          </label>
          <textarea id="review-comment" rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Например: клиентка подтвердила перевод по звонку" data-testid="review-comment" />
          {error ? (
            <p className="field-error" role="alert" data-testid="review-error">
              {error}
            </p>
          ) : null}
          <div className="decision-actions">
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void act('reject')} data-testid="review-reject">
              {busy === 'reject' ? 'Отклоняем…' : 'Отклонить и разморозить'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy !== null} data-testid="review-approve">
              {busy === 'approve' ? 'Одобряем…' : 'Одобрить перевод'}
            </button>
          </div>
        </form>
      ) : (
        <div className="office-panel office-block" data-testid="review-result">
          <h3>Решение</h3>
          <dl className="dl">
            <div>
              <dt>Итог</dt>
              <dd>{REVIEW_STATE_LABEL[review.state]}</dd>
            </div>
            <div>
              <dt>Кто решил</dt>
              <dd>{review.resolvedBy ?? '—'}</dd>
            </div>
            <div>
              <dt>Когда</dt>
              <dd className="mono">{review.resolvedAt ? `${fullDate(review.resolvedAt)} ${timeOf(review.resolvedAt)}` : '—'}</dd>
            </div>
            <div>
              <dt>Комментарий</dt>
              <dd>{review.comment ?? '—'}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

function recentRecipient(row: ReviewDetails['recentOperations'][number]): string {
  return recipientLabel(row).split(',')[0] ?? '';
}
