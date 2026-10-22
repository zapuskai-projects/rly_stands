import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { Money } from '../components/Money';
import { officeApi } from '../lib/api';
import { formatPhone } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { CLIENT_KIND_LABEL } from '../lib/office-labels';
import type { OfficeClient, Page } from '../lib/types';

const PAGE_SIZE = 20;

export function ClientsPage() {
  useDocumentTitle('Клиенты · ЗапускБанк');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  const state = useAsync(() => officeApi.get<Page<OfficeClient>>('/api/v1/office/clients', { query, limit: PAGE_SIZE, offset }), [query, offset]);
  const page = state.data;

  return (
    <div className="stack gap-16">
      <div className="office-panel office-toolbar">
        <div className="field">
          <label htmlFor="client-query">Поиск по имени, телефону или номеру клиента</label>
          <input id="client-query" className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="Соколова, +7900…, 10000001" data-testid="client-search" />
        </div>
      </div>
      <section className="office-panel" aria-label="Клиенты">
        {page ? (
          page.items.length > 0 ? (
            <div className="table-wrap">
              <table className="table" data-testid="clients-table">
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>Клиент</th>
                    <th>Телефон</th>
                    <th>Вид</th>
                    <th>Тариф</th>
                    <th style={{ textAlign: 'right' }}>Остаток</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((client) => (
                    <tr key={client.id} data-testid="client-row">
                      <td className="mono">{client.number}</td>
                      <td>
                        <Link to={`/office/clients/${client.id}`} data-testid="client-link">
                          {client.fullName}
                        </Link>
                      </td>
                      <td className="mono">{formatPhone(client.phone)}</td>
                      <td>{CLIENT_KIND_LABEL[client.kind]}{client.resident ? '' : ', нерезидент'}</td>
                      <td>{client.tariff.name}</td>
                      <td style={{ textAlign: 'right' }}><Money value={client.totalBalance} /></td>
                      <td><Pill tone={client.status === 'ACTIVE' ? 'ok' : 'bad'}>{client.status === 'ACTIVE' ? 'Активен' : 'Заблокирован'}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="state" data-testid="empty">Клиентов с такими данными нет</div>
          )
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading />
        )}
        {page && page.total > PAGE_SIZE ? (
          <div className="pager">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="page-prev">Назад</button>
            <span className="muted">{offset + 1}–{offset + page.items.length} из {page.total}</span>
            <button type="button" className="btn" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="page-next">Дальше</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
