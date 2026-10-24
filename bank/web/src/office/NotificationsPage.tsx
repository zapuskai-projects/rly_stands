import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pill } from '../components/StatusPill';
import { Empty, ErrorBox, Loading } from '../components/States';
import { officeApi } from '../lib/api';
import { dayAndTime, formatPhone, normalizePhone } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { notificationKindLabels } from '../lib/office-labels';
import { releaseAtLeast, useBankRelease } from '../lib/release';
import type { OfficeNotification, Page } from '../lib/types';

const PAGE_SIZE = 20;

export function NotificationsPage() {
  useDocumentTitle('Уведомления · ЗапускБанк');
  const [phoneText, setPhoneText] = useState('');
  const [kind, setKind] = useState('');
  const [channel, setChannel] = useState('');
  const [offset, setOffset] = useState(0);
  const [phone, setPhone] = useState<string | null>(null);
  const kindLabels = notificationKindLabels(releaseAtLeast(useBankRelease(), '1.1'));

  useEffect(() => {
    const timer = setTimeout(() => {
      setPhone(phoneText.trim() ? normalizePhone(phoneText) : null);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [phoneText]);

  const invalidPhone = phoneText.trim() !== '' && phone === null;
  const state = useAsync(
    () => officeApi.get<Page<OfficeNotification>>('/api/v1/office/notifications', { phone, kind, channel, limit: PAGE_SIZE, offset }),
    [phone, kind, channel, offset],
    5000,
  );
  const page = state.data;

  return (
    <div className="stack gap-16">
      <form className="office-panel office-toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="n-phone">Телефон</label>
          <input id="n-phone" className={`input input-mono${invalidPhone ? ' input-invalid' : ''}`} placeholder="+7 900 111-00-01" value={phoneText} onChange={(event) => setPhoneText(event.target.value)} data-testid="notification-phone" />
          {invalidPhone ? <span className="field-error" data-testid="notification-phone-error">Введите мобильный номер полностью</span> : null}
        </div>
        <div className="field">
          <label htmlFor="n-kind">Вид</label>
          <select id="n-kind" className="input" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }} data-testid="notification-kind">
            <option value="">Любой</option>
            {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="n-channel">Канал</label>
          <select id="n-channel" className="input" value={channel} onChange={(event) => { setChannel(event.target.value); setOffset(0); }} data-testid="notification-channel">
            <option value="">Любой</option>
            <option value="SMS">СМС</option>
            <option value="PUSH">Пуш</option>
          </select>
        </div>
      </form>
      <section className="office-panel" aria-label="Журнал уведомлений">
        {page ? (
          page.items.length > 0 ? (
            <div className="table-wrap">
              <table className="table" data-testid="notifications-table">
                <thead><tr><th>Время</th><th>Кому</th><th>Вид</th><th>Канал</th><th>Текст</th><th>Операция</th></tr></thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr key={item.id} data-testid="notification-row" data-kind={item.kind}>
                      <td className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{dayAndTime(item.createdAt)}</td>
                      <td><div className="mono" style={{ fontSize: 13 }}>{formatPhone(item.phone)}</div><div className="muted" style={{ fontSize: 12.5 }}>{item.clientName ?? ''}</div></td>
                      <td>{kindLabels[item.kind] ?? item.kind}</td>
                      <td><Pill tone={item.channel === 'SMS' ? 'info' : 'neutral'}>{item.channel === 'SMS' ? 'СМС' : 'Пуш'}</Pill></td>
                      <td style={{ minWidth: 240 }}>{item.text}</td>
                      <td>{item.operationNumber ? <Link to={`/office/operations?number=${item.operationNumber}`} className="mono" data-testid="notification-operation-link">{item.operationNumber}</Link> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Уведомлений с такими условиями нет</Empty>
          )
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading />
        )}
        {page && page.total > PAGE_SIZE ? (
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
