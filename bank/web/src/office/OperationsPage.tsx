import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Loading } from '../components/States';
import { officeApi } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { useBankRelease } from '../lib/release';
import { STATUS_LABEL, TYPE_LABEL, typeFilterOptions } from '../lib/status';
import type { OfficeOperationRow, OperationStatus, Page } from '../lib/types';
import { OfficeOperationTable } from './OfficeOperationTable';

const PAGE_SIZE = 20;

export function OperationsPage() {
  useDocumentTitle('Операции · ЗапускБанк');
  const release = useBankRelease();
  const [params] = useSearchParams();
  const [number, setNumber] = useState(params.get('number') ?? '');
  const [clientNumber, setClientNumber] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [applied, setApplied] = useState({ number: params.get('number') ?? '', clientNumber: '' });
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied({ number: number.trim(), clientNumber: clientNumber.trim() });
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [number, clientNumber]);

  const state = useAsync(
    () => officeApi.get<Page<OfficeOperationRow>>('/api/v1/office/operations', { ...applied, status, type, limit: PAGE_SIZE, offset }),
    [applied.number, applied.clientNumber, status, type, offset],
  );
  const page = state.data;

  return (
    <div className="stack gap-16">
      <form className="office-panel office-toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="op-number">Номер операции</label>
          <input id="op-number" className="input input-mono" placeholder="ZB0000100001" value={number} onChange={(event) => setNumber(event.target.value)} data-testid="operation-search" />
        </div>
        <div className="field">
          <label htmlFor="op-client">Номер клиента</label>
          <input id="op-client" className="input input-mono" placeholder="10000001" value={clientNumber} onChange={(event) => setClientNumber(event.target.value)} data-testid="operation-client-filter" />
        </div>
        <div className="field">
          <label htmlFor="op-status">Статус</label>
          <select id="op-status" className="input" value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} data-testid="operation-status-filter">
            <option value="">Любой</option>
            {(Object.keys(STATUS_LABEL) as OperationStatus[]).map((value) => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="op-type">Вид</label>
          <select id="op-type" className="input" value={type} onChange={(event) => { setType(event.target.value); setOffset(0); }} data-testid="operation-type-filter">
            <option value="">Любой</option>
            {typeFilterOptions(release).map((value) => <option key={value} value={value}>{TYPE_LABEL[value]}</option>)}
          </select>
        </div>
      </form>
      <section className="office-panel" aria-label="Операции">
        {page ? (
          page.items.length > 0 ? <OfficeOperationTable rows={page.items} /> : <Empty>Операций с такими условиями нет</Empty>
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading />
        )}
        {page && page.total > 0 ? (
          <div className="pager">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="page-prev">Назад</button>
            <span className="muted" data-testid="page-info">{offset + 1}–{offset + page.items.length} из {page.total}</span>
            <button type="button" className="btn" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="page-next">Дальше</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
