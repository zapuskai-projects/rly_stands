import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Money } from '../components/Money';
import { Pill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { explain, officeApi } from '../lib/api';
import { formatAccountNumber, formatPhone, formatWholeRubles, fullDate, parseAmount } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { CLIENT_KIND_LABEL } from '../lib/office-labels';
import { releaseAtLeast, useBankRelease } from '../lib/release';
import type { OfficeClientDetails } from '../lib/types';
import { ClientTemplates } from './ClientTemplates';
import { OfficeOperationTable } from './OfficeOperationTable';
import { useOperator } from './office-context';

function LimitEditor({ details, onChanged }: { details: OfficeClientDetails; onChanged: (message: string) => void }) {
  const operator = useOperator();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const senior = operator.role === 'SENIOR';

  const save = async (value: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await officeApi.put(`/api/v1/office/clients/${details.client.id}/daily-limit`, { dailyPhoneTransferLimit: value });
      setText('');
      onChanged(value === null ? 'Личный лимит снят, действует лимит тарифа' : 'Личный лимит сохранён');
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap-8" data-testid="limit-editor">
      <dl className="dl">
        <div><dt>Лимит тарифа в сутки</dt><dd className="mono">{formatWholeRubles(details.tariff.dailyPhoneTransferLimit)}</dd></div>
        <div><dt>Личный лимит</dt><dd className="mono" data-testid="limit-override">{details.dailyLimitOverride === null ? 'не задан' : formatWholeRubles(details.dailyLimitOverride)}</dd></div>
        <div><dt>Действует сейчас</dt><dd className="mono" data-testid="limit-effective">{formatWholeRubles(details.limits.dailyPhoneTransfer.limit)}</dd></div>
      </dl>
      {senior ? (
        <form
          className="row wrap gap-8"
          onSubmit={(event) => {
            event.preventDefault();
            const value = parseAmount(text);
            if (value === null) setError('Введите сумму больше нуля, например 50000');
            else void save(value);
          }}
        >
          <input className="input input-mono" style={{ flex: '1 1 160px' }} placeholder="Новый лимит, ₽" value={text} onChange={(event) => setText(event.target.value)} aria-label="Новый личный лимит" data-testid="limit-input" />
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="limit-save">Сохранить</button>
          <button type="button" className="btn" disabled={busy || details.dailyLimitOverride === null} onClick={() => void save(null)} title={details.dailyLimitOverride === null ? 'Личный лимит не задан' : undefined} data-testid="limit-reset">
            Вернуть лимит тарифа
          </button>
        </form>
      ) : (
        <p className="muted" data-testid="limit-readonly">Личные лимиты меняет старший оператор. Вы вошли как оператор.</p>
      )}
      {error ? <p className="field-error" role="alert" data-testid="limit-error">{error}</p> : null}
    </div>
  );
}

export function ClientPage() {
  const { id = '' } = useParams();
  const [toast, setToast] = useState<string | null>(null);
  const state = useAsync(() => officeApi.get<OfficeClientDetails>(`/api/v1/office/clients/${id}`), [id]);
  const release = useBankRelease();
  const data = state.data;
  useDocumentTitle(data ? `${data.client.fullName} · ЗапускБанк` : 'Клиент · ЗапускБанк');

  if (!data) return <div className="office-panel">{state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : <Loading rows={5} />}</div>;
  const { client } = data;
  return (
    <div className="stack gap-16" data-testid="office-client">
      <div className="office-panel review-head">
        <div className="stack gap-4">
          <span className="mono muted">Клиент {client.number}</span>
          <h1 className="review-amount" style={{ fontFamily: 'var(--sans)' }} data-testid="client-name">{client.fullName}</h1>
          <span className="muted">{CLIENT_KIND_LABEL[client.kind]}{client.resident ? '' : ', нерезидент'} · с {fullDate(client.customerSince)}</span>
        </div>
        <div className="stack gap-4" style={{ alignItems: 'flex-end' }}>
          <Pill tone={client.status === 'ACTIVE' ? 'ok' : 'bad'}>{client.status === 'ACTIVE' ? 'Активен' : 'Заблокирован'}</Pill>
          <span className="mono">{formatPhone(client.phone)}</span>
          <span className="muted">Тариф «{client.tariff.name}»{client.inn ? ` · ИНН ${client.inn}` : ''}</span>
        </div>
      </div>
      <div className="review-grid">
        <section className="office-panel office-block" aria-label="Счета">
          <h3>Счета</h3>
          <div className="table-wrap">
            <table className="table" data-testid="client-accounts">
              <thead><tr><th>Счёт</th><th style={{ textAlign: 'right' }}>Остаток</th><th style={{ textAlign: 'right' }}>Доступно</th></tr></thead>
              <tbody>
                {data.accounts.map((account) => (
                  <tr key={account.id} data-testid="client-account">
                    <td>
                      <div>{account.title}{account.status === 'ARRESTED' ? <> <Pill tone="bad">Арест</Pill></> : null}</div>
                      <div className="mono muted" style={{ fontSize: 12.5 }}>{formatAccountNumber(account.number)}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}><Money value={account.balance} /></td>
                    <td style={{ textAlign: 'right' }}><Money value={account.available} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="office-panel office-block" aria-label="Лимиты">
          <h3>Лимиты</h3>
          <dl className="dl">
            <div><dt>Переводы по телефону сегодня</dt><dd className="mono">{formatWholeRubles(data.limits.dailyPhoneTransfer.used)} из {formatWholeRubles(data.limits.dailyPhoneTransfer.limit)}</dd></div>
            <div><dt>Без комиссии в этом месяце</dt><dd className="mono">{formatWholeRubles(data.limits.monthlyFreeVolume.used)} из {formatWholeRubles(data.limits.monthlyFreeVolume.limit)}</dd></div>
          </dl>
          <LimitEditor
            details={data}
            onChanged={(message) => {
              setToast(message);
              state.reload();
            }}
          />
        </section>
      </div>
      <section className="office-panel office-block" aria-label="Последние операции">
        <h3>Последние операции</h3>
        {data.recentOperations.length > 0 ? <OfficeOperationTable rows={data.recentOperations} showClient={false} /> : <span className="muted">Операций пока нет</span>}
      </section>
      {releaseAtLeast(release, '1.1') ? <ClientTemplates clientId={id} /> : null}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
