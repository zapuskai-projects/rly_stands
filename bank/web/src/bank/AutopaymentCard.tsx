import { useState } from 'react';
import { Pill } from '../components/StatusPill';
import { explain, clientApi } from '../lib/api';
import { attemptNote, AUTOPAYMENT_STATUS_LABEL, AUTOPAYMENT_STATUS_TONE, dateLabel, schedulePhrase } from '../lib/autopay-labels';
import { formatMoney } from '../lib/format';
import type { Autopayment } from '../lib/types';
import { AutopaymentRuns } from './AutopaymentRuns';

type Action = 'pause' | 'resume' | 'cancel';

export function AutopaymentCard({ autopayment, onChanged, onMessage }: { autopayment: Autopayment; onChanged: () => void; onMessage: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const { status } = autopayment;
  const note = attemptNote(autopayment);

  const run = async (action: Action) => {
    setBusy(true);
    try {
      if (action === 'cancel') await clientApi.delete(`/api/v1/autopayments/${autopayment.id}`);
      else await clientApi.post(`/api/v1/autopayments/${autopayment.id}/${action}`);
      onMessage({ pause: 'Автоплатёж поставлен на паузу', resume: 'Автоплатёж возобновлён', cancel: 'Автоплатёж отменён' }[action]);
      setConfirming(false);
      onChanged();
    } catch (error) {
      onMessage(explain(error));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card panel" data-testid="autopayment-card" data-autopayment-name={autopayment.templateName} data-autopayment-status={status}>
      <div className="row between wrap gap-8">
        <h3 style={{ fontSize: 17, fontWeight: 700 }} data-testid="autopayment-name">{autopayment.templateName}</h3>
        <Pill tone={AUTOPAYMENT_STATUS_TONE[status]} testId="autopayment-status">{AUTOPAYMENT_STATUS_LABEL[status]}</Pill>
      </div>
      <dl className="dl">
        <div>
          <dt>Сумма</dt>
          <dd className="mono" data-testid="autopayment-amount">{formatMoney(autopayment.amount)}</dd>
        </div>
        <div>
          <dt>Расписание</dt>
          <dd>{schedulePhrase(autopayment)}</dd>
        </div>
        <div>
          <dt>Ближайший платёж</dt>
          <dd data-testid="autopayment-next">{autopayment.nextRunOn ? dateLabel(autopayment.nextRunOn) : 'не назначен'}</dd>
        </div>
        {autopayment.endsOn ? (
          <div>
            <dt>Действует до</dt>
            <dd>{dateLabel(autopayment.endsOn)}</dd>
          </div>
        ) : null}
      </dl>
      {note ? (
        <p className={status === 'FAILED' ? 'field-error' : 'op-sub warn'} role="status" data-testid="autopayment-note">
          {note}
        </p>
      ) : null}
      <div className="row-actions">
        {status === 'ACTIVE' ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run('pause')} data-testid="autopayment-pause">
            Поставить на паузу
          </button>
        ) : null}
        {status === 'PAUSED' || status === 'FAILED' ? (
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void run('resume')} data-testid="autopayment-resume">
            Возобновить
          </button>
        ) : null}
        {status !== 'FINISHED' && !confirming ? (
          <button type="button" className="btn btn-small" onClick={() => setConfirming(true)} data-testid="autopayment-cancel">
            Отменить
          </button>
        ) : null}
        {confirming ? (
          <>
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void run('cancel')} data-testid="autopayment-cancel-confirm">
              Да, отменить навсегда
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirming(false)} data-testid="autopayment-cancel-back">
              Оставить
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-small" aria-expanded={showRuns} onClick={() => setShowRuns((value) => !value)} data-testid="autopayment-history">
          {showRuns ? 'Скрыть историю' : 'История запусков'}
        </button>
      </div>
      {showRuns ? <AutopaymentRuns autopaymentId={autopayment.id} /> : null}
    </article>
  );
}
