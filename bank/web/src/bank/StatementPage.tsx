import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { bankDateKey } from '../lib/bank-time';
import { clientApi } from '../lib/api';
import { dayAndTime, formatAccountNumber, formatMoney } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Account, Statement } from '../lib/types';
import { accountLabel } from './transfer-shared';

function monthStart(today: string): string {
  return `${today.slice(0, 8)}01`;
}

export function StatementPage() {
  useDocumentTitle('Выписка · ЗапускБанк');
  const accounts = useAsync(async () => (await clientApi.get<{ items: Account[] }>('/api/v1/accounts')).items, []);
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(() => monthStart(bankDateKey()));
  const [to, setTo] = useState(() => bankDateKey());

  useEffect(() => {
    if (!accountId && accounts.data?.[0]) setAccountId((accounts.data.find((account) => account.isPrimary) ?? accounts.data[0]).id);
  }, [accounts.data, accountId]);

  const statement = useAsync(
    () => (accountId ? clientApi.get<Statement>(`/api/v1/accounts/${accountId}/statement`, { from, to }) : Promise.resolve(null)),
    [accountId, from, to],
  );
  const invalid = from > to;
  const data = statement.data;

  return (
    <main className="bank-page">
      <div className="bank-col" style={{ flexBasis: '100%' }}>
        <h1 className="page-title">Выписка по счёту</h1>
        <form className="card filters" onSubmit={(event) => event.preventDefault()} data-testid="statement-filters">
          <div className="field" style={{ flexBasis: 280 }}>
            <label htmlFor="s-account">Счёт</label>
            <select id="s-account" className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)} data-testid="statement-account">
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-from">С даты</label>
            <input id="s-from" className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} data-testid="statement-from" />
          </div>
          <div className="field">
            <label htmlFor="s-to">По дату</label>
            <input id="s-to" className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} data-testid="statement-to" />
          </div>
        </form>
        {invalid ? (
          <p className="field-error" role="alert" data-testid="statement-period-error">
            Начало периода позже его конца
          </p>
        ) : data ? (
          <section className="card" aria-label="Выписка" data-testid="statement">
            <div className="statement-totals">
              <div>
                <div className="label">Остаток на начало</div>
                <div className="value" data-testid="statement-opening">{formatMoney(data.openingBalance)}</div>
              </div>
              <div>
                <div className="label">Списано</div>
                <div className="value" data-testid="statement-debit">{formatMoney(data.totalDebit)}</div>
              </div>
              <div>
                <div className="label">Зачислено</div>
                <div className="value" data-testid="statement-credit">{formatMoney(data.totalCredit)}</div>
              </div>
              <div>
                <div className="label">Остаток на конец</div>
                <div className="value" data-testid="statement-closing">{formatMoney(data.closingBalance)}</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table" data-testid="statement-table">
                <thead>
                  <tr>
                    <th>Дата и время</th>
                    <th>Описание</th>
                    <th style={{ textAlign: 'right' }}>Списание</th>
                    <th style={{ textAlign: 'right' }}>Зачисление</th>
                    <th style={{ textAlign: 'right' }}>Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry) => (
                    <tr key={entry.id} data-testid="statement-row">
                      <td className="mono">{dayAndTime(entry.postedAt)}</td>
                      <td>{entry.operationId ? <Link to={`/operations/${entry.operationId}`} data-testid="statement-operation-link">{entry.description}</Link> : entry.description}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{entry.direction === 'DEBIT' ? formatMoney(entry.amount) : ''}</td>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--ok)' }}>{entry.direction === 'CREDIT' ? formatMoney(entry.amount) : ''}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(entry.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.entries.length === 0 ? (
                <div className="state" data-testid="empty">
                  За выбранный период проводок нет
                </div>
              ) : null}
            </div>
            <p className="muted" style={{ padding: '0 18px 16px', fontSize: 13 }}>
              Счёт {formatAccountNumber(data.accountNumber)} · остатки считаются по проводкам счёта
            </p>
          </section>
        ) : statement.error ? (
          <ErrorBox error={statement.error} onRetry={statement.reload} />
        ) : (
          <Loading />
        )}
      </div>
    </main>
  );
}
