import { useEffect, useState } from 'react';
import { ErrorBox, Loading } from '../components/States';
import { clientApi } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { useBankRelease } from '../lib/release';
import { STATUS_LABEL, TYPE_LABEL, typeFilterOptions } from '../lib/status';
import type { Operation, OperationStatus, Page } from '../lib/types';
import { OperationList } from './OperationList';

const PAGE_SIZE = 15;

interface Filters {
  status: string;
  type: string;
  from: string;
  to: string;
  number: string;
}

const EMPTY: Filters = { status: '', type: '', from: '', to: '', number: '' };

export function HistoryPage() {
  useDocumentTitle('История · ЗапускБанк');
  const release = useBankRelease();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(filters);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters]);

  const state = useAsync(
    () =>
      clientApi.get<Page<Operation>>('/api/v1/operations', {
        status: applied.status,
        type: applied.type,
        from: applied.from,
        to: applied.to,
        number: applied.number.trim(),
        limit: PAGE_SIZE,
        offset,
      }),
    [applied.status, applied.type, applied.from, applied.to, applied.number, offset],
  );

  const set = (key: keyof Filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const page = state.data;
  const filtered = Object.values(applied).some(Boolean);

  return (
    <main className="bank-page">
      <div className="bank-col" style={{ flexBasis: '100%' }}>
        <h1 className="page-title">История операций</h1>
        <form className="card filters" onSubmit={(event) => event.preventDefault()} data-testid="history-filters">
          <div className="field">
            <label htmlFor="f-status">Статус</label>
            <select id="f-status" className="input" value={filters.status} onChange={(event) => set('status')(event.target.value)} data-testid="filter-status">
              <option value="">Любой</option>
              {(Object.keys(STATUS_LABEL) as OperationStatus[]).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-type">Вид</label>
            <select id="f-type" className="input" value={filters.type} onChange={(event) => set('type')(event.target.value)} data-testid="filter-type">
              <option value="">Любой</option>
              {typeFilterOptions(release).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">С даты</label>
            <input id="f-from" className="input" type="date" value={filters.from} onChange={(event) => set('from')(event.target.value)} data-testid="filter-from" />
          </div>
          <div className="field">
            <label htmlFor="f-to">По дату</label>
            <input id="f-to" className="input" type="date" value={filters.to} onChange={(event) => set('to')(event.target.value)} data-testid="filter-to" />
          </div>
          <div className="field">
            <label htmlFor="f-number">Номер операции</label>
            <input id="f-number" className="input input-mono" placeholder="ZB0000100001" value={filters.number} onChange={(event) => set('number')(event.target.value)} data-testid="filter-number" />
          </div>
          <button type="button" className="btn" disabled={!Object.values(filters).some(Boolean)} onClick={() => setFilters(EMPTY)} data-testid="filter-reset">
            Сбросить
          </button>
        </form>
        <section className="card ops" aria-label="Операции">
          {page ? (
            page.items.length > 0 ? (
              <>
                <OperationList operations={page.items} />
                <div className="pager">
                  <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="page-prev">
                    Назад
                  </button>
                  <span className="muted" data-testid="page-info">
                    {offset + 1}–{offset + page.items.length} из {page.total}
                  </span>
                  <button type="button" className="btn" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="page-next">
                    Дальше
                  </button>
                </div>
              </>
            ) : (
              <div className="state" data-testid="empty">
                {filtered ? 'Под фильтр ничего не подошло. Измените условия или сбросьте их.' : 'Операций пока нет'}
              </div>
            )
          ) : state.error ? (
            <ErrorBox error={state.error} onRetry={state.reload} />
          ) : (
            <Loading />
          )}
        </section>
      </div>
    </main>
  );
}
