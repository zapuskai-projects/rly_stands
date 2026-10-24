import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pill, StatusPill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { clientApi } from '../lib/api';
import { formatAccountNumber, formatMoney, formatPhone, timeWithSeconds, dayAndTime } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { releaseAtLeast, useBankRelease } from '../lib/release';
import { isActive, statusHint, statusTone, TYPE_LABEL } from '../lib/status';
import { buildTimeline } from '../lib/timeline';
import type { Operation } from '../lib/types';
import { SaveAsTemplate } from './SaveAsTemplate';

const ICON_PATH: Record<string, string> = {
  ok: 'M6 12.5 L10.5 17 L18 8',
  warn: 'M12 7.5 V12 L15 14',
  bad: 'M7 7 L17 17 M17 7 L7 17',
  info: 'M12 7.5 V12 L15 14',
};

function StatusIcon({ operation }: { operation: Operation }) {
  const tone = statusTone(operation.status);
  const colors = { ok: ['var(--ok-bg)', 'var(--ok)'], warn: ['var(--warn-bg)', 'var(--warn)'], bad: ['var(--bad-bg)', 'var(--bad)'], info: ['var(--brand-tint)', 'var(--brand)'], neutral: ['var(--neutral-bg)', 'var(--ink)'] }[tone];
  const clock = tone === 'warn' || tone === 'info';
  return (
    <span className="op-icon" style={{ background: colors[0], color: colors[1] }}>
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
        {clock ? <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" fill="none" /> : null}
        <path d={ICON_PATH[tone] ?? ICON_PATH.info} stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Timeline({ operation }: { operation: Operation }) {
  return (
    <section aria-label="Ход операции" className="card timeline" data-testid="timeline">
      <h2>Ход операции</h2>
      {buildTimeline(operation).map((step) => (
        <div key={step.key} className={`step ${step.state}`} data-testid="timeline-step" data-step={step.key} data-state={step.state}>
          <span className={`dot ${step.warn ? 'warn' : step.state === 'done' ? '' : step.state}`.trim()} aria-hidden="true" />
          <span className="step-label">{step.label}</span>
          <span className="step-time">{step.at ? timeWithSeconds(step.at) : ''}</span>
        </div>
      ))}
    </section>
  );
}

export function OperationPage() {
  const { id = '' } = useParams();
  const [toast, setToast] = useState<string | null>(null);
  const release = useBankRelease();
  const state = useAsync(() => clientApi.get<Operation>(`/api/v1/operations/${id}`), [id], 2000, (operation) => isActive(operation.status));
  const operation = state.data;
  useDocumentTitle(operation ? `Операция ${operation.number} · ЗапускБанк` : 'Операция · ЗапускБанк');

  const copy = async () => {
    if (!operation) return;
    try {
      await navigator.clipboard.writeText(operation.number);
      setToast('Номер операции скопирован');
    } catch {
      setToast(`Номер операции: ${operation.number}`);
    }
  };

  return (
    <>
      <div className="screen-head">
        <div className="screen-head-inner">
          <Link to="/" className="back" aria-label="Назад" data-testid="back">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5 L8 12 L15 19" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1>Операция</h1>
        </div>
      </div>
      <main className="form-page">
        {operation ? (
          <>
            <section className="card op-hero" data-testid="operation-hero">
              <StatusIcon operation={operation} />
              <div className="big" data-testid="operation-amount">
                −{formatMoney(operation.amount)}
              </div>
              <div style={{ fontWeight: 600 }} data-testid="operation-recipient">
                {operation.type === 'OWN_TRANSFER'
                  ? 'Между своими счетами'
                  : `${operation.recipient.displayName ?? (operation.recipient.phone ? formatPhone(operation.recipient.phone) : 'Получатель')} · ${operation.recipient.bankName ?? ''}`}
              </div>
              <StatusPill status={operation.status} />
              <p className="muted" style={{ fontSize: 14 }} data-testid="operation-hint">
                {statusHint(operation)}
              </p>
            </section>
            <Timeline operation={operation} />
            <dl className="card dl details" data-testid="operation-details">
              <div>
                <dt>Номер операции</dt>
                <dd className="mono" data-testid="operation-number">
                  {operation.number}
                </dd>
              </div>
              <div>
                <dt>Вид</dt>
                <dd>{TYPE_LABEL[operation.type]}</dd>
              </div>
              <div>
                <dt>Откуда</dt>
                <dd className="mono">{formatAccountNumber(operation.fromAccount.number)}</dd>
              </div>
              {operation.recipient.phone ? (
                <div>
                  <dt>Телефон</dt>
                  <dd className="mono">{formatPhone(operation.recipient.phone)}</dd>
                </div>
              ) : null}
              {operation.recipient.accountNumber ? (
                <div>
                  <dt>Куда</dt>
                  <dd className="mono">{formatAccountNumber(operation.recipient.accountNumber)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Комиссия</dt>
                <dd className="mono" data-testid="operation-fee">
                  {formatMoney(operation.fee)}
                </dd>
              </div>
              <div>
                <dt>Создана</dt>
                <dd className="mono">{dayAndTime(operation.createdAt)}</dd>
              </div>
              {operation.comment ? (
                <div>
                  <dt>Сообщение</dt>
                  <dd>{operation.comment}</dd>
                </div>
              ) : null}
              {operation.templateId ? (
                <div>
                  <dt>Способ</dt>
                  <dd data-testid="operation-by-template">По шаблону</dd>
                </div>
              ) : null}
            </dl>
            <div className="action-bar">
              <button type="button" className="btn" onClick={() => void copy()} data-testid="copy-number">
                Скопировать номер
              </button>
              <button type="button" className="btn" onClick={() => window.print()} data-testid="print-receipt">
                Чек
              </button>
            </div>
            {operation.status === 'COMPLETED' && releaseAtLeast(release, '1.1') ? <SaveAsTemplate operation={operation} onSaved={setToast} /> : null}
            {isActive(operation.status) ? (
              <Pill tone="info">
                <span data-testid="operation-polling">Статус обновляется сам</span>
              </Pill>
            ) : null}
          </>
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={5} />
        )}
      </main>
      <Toast message={toast} onClose={() => setToast(null)} />
    </>
  );
}
