import { useEffect, useState, type FormEvent } from 'react';
import { Avatar } from '../components/Avatar';
import { Pill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { ApiError, clientApi } from '../lib/api';
import { formatMoney, timeOf } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { payLabel, qrBlockReason } from '../lib/qr-labels';
import type { Account, QrPurchase } from '../lib/types';
import { ScreenHead } from './ScreenHead';
import { AccountSelect, useTransferSubmit } from './transfer-shared';

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; data: QrPurchase } | { state: 'error'; message: string };

function useQrLookup(payload: string): Lookup {
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  useEffect(() => {
    const text = payload.trim();
    if (!text) {
      setLookup({ state: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setLookup({ state: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const data = await clientApi.get<QrPurchase>('/api/v1/qr-payments/lookup', { payload: text });
        if (!cancelled) setLookup({ state: 'ok', data });
      } catch (error) {
        if (!cancelled) setLookup({ state: 'error', message: error instanceof ApiError ? error.message : 'Не удалось прочитать QR-код' });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payload]);
  return lookup;
}

function PurchaseCard({ lookup }: { lookup: Lookup }) {
  if (lookup.state === 'idle') return null;
  if (lookup.state === 'loading') {
    return (
      <div className="recipient-card muted" data-testid="qr-loading">
        Читаем QR-код…
      </div>
    );
  }
  if (lookup.state === 'error') {
    return (
      <span className="field-error" role="alert" data-testid="qr-error">
        {lookup.message}
      </span>
    );
  }
  const { data } = lookup;
  const blocked = qrBlockReason(data.status);
  return (
    <div className="stack gap-12" data-testid="qr-purchase">
      <div className="recipient-card">
        <Avatar name={data.merchant} tone={blocked ? 'warn' : 'neutral'} />
        <div className="stack">
          <span style={{ fontWeight: 600 }} data-testid="qr-merchant">
            {data.merchant}
          </span>
          <span className="muted" style={{ fontSize: 13 }} data-testid="qr-description">
            {data.description}
          </span>
        </div>
        <span className="mono" style={{ marginLeft: 'auto', fontWeight: 700 }} data-testid="qr-amount">
          {formatMoney(data.amount)}
        </span>
      </div>
      {blocked ? (
        <Pill tone="bad" testId="qr-blocked">
          {blocked}
        </Pill>
      ) : (
        <span className="muted" style={{ fontSize: 13 }} data-testid="qr-expires">
          Действует до {timeOf(data.expiresAt)}
        </span>
      )}
    </div>
  );
}

function QrPayForm({ accounts }: { accounts: Account[] }) {
  const [payload, setPayload] = useState('');
  const [fromId, setFromId] = useState(accounts.find((account) => account.isPrimary)?.id ?? accounts[0]?.id ?? '');
  const [general, setGeneral] = useState<string | null>(null);
  const { submit, busy } = useTransferSubmit('/api/v1/qr-payments');
  const lookup = useQrLookup(payload);

  const from = accounts.find((account) => account.id === fromId);
  const purchase = lookup.state === 'ok' ? lookup.data : null;
  const blocked = purchase ? qrBlockReason(purchase.status) : null;
  const shortage = purchase && from && purchase.amount > from.available ? `Недостаточно средств. Доступно ${formatMoney(from.available)}` : null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setGeneral(null);
    if (!purchase) {
      if (lookup.state === 'idle') setGeneral('Вставьте содержимое QR-кода');
      if (lookup.state === 'loading') setGeneral('Читаем QR-код, подождите секунду');
      return;
    }
    if (blocked || shortage) return;
    const failure = await submit({ payload: payload.trim(), accountId: fromId });
    if (failure) setGeneral(failure.fields.amount ?? failure.general);
  };

  return (
    <form className="stack gap-16" onSubmit={onSubmit} noValidate data-testid="qr-pay-form">
      <div className="form-panel">
        <div className="field">
          <label htmlFor="qr-payload">Содержимое QR-кода</label>
          <input
            id="qr-payload"
            className={`input input-mono${lookup.state === 'error' ? ' input-invalid' : ''}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="zbqr://pay?id=…"
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            aria-invalid={lookup.state === 'error' ? true : undefined}
            data-testid="qr-payload"
          />
        </div>
        <PurchaseCard lookup={lookup} />
        <AccountSelect id="from" label="Откуда" accounts={accounts} value={fromId} onChange={setFromId} testId="qr-from" />
        {shortage && !blocked ? (
          <span className="field-error" role="alert" data-testid="qr-shortage">
            {shortage}
          </span>
        ) : null}
        {general ? (
          <p className="field-error" role="alert" data-testid="qr-submit-error">
            {general}
          </p>
        ) : null}
      </div>
      <div className="sticky-action">
        <div className="sticky-action-inner">
          <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid="qr-submit">
            {busy ? 'Оплачиваем…' : payLabel(purchase?.amount ?? null)}
          </button>
        </div>
      </div>
    </form>
  );
}

export function QrPayPage() {
  useDocumentTitle('Оплатить по QR · ЗапускБанк');
  const state = useAsync(async () => (await clientApi.get<{ items: Account[] }>('/api/v1/accounts')).items, []);
  return (
    <>
      <ScreenHead title="Оплатить по QR" />
      <main className="form-page">
        {state.data ? (
          <QrPayForm accounts={state.data} />
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={4} />
        )}
      </main>
    </>
  );
}
