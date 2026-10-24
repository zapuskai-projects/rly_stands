import { Money } from '../components/Money';
import { Pill } from '../components/StatusPill';
import { ErrorBox, Loading } from '../components/States';
import { officeApi } from '../lib/api';
import { AUTOPAYMENT_STATUS_LABEL, AUTOPAYMENT_STATUS_TONE, attemptNote, dateLabel, schedulePhrase, templateRecipient } from '../lib/autopay-labels';
import { useAsync } from '../lib/hooks';
import type { OfficeAutopayment, Template } from '../lib/types';
import { RunsTable } from '../bank/AutopaymentRuns';

const KIND_LABEL = { PHONE: 'По телефону', SBP: 'В другой банк', OWN: 'Между своими счетами' } as const;

function Templates({ clientId }: { clientId: string }) {
  const state = useAsync(() => officeApi.get<{ items: Template[] }>(`/api/v1/office/clients/${clientId}/templates`), [clientId]);
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading rows={2} />;
  if (state.data.items.length === 0) return <span className="muted" data-testid="office-templates-empty">Шаблонов нет</span>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="office-templates">
        <thead>
          <tr>
            <th>Название</th>
            <th>Вид</th>
            <th>Получатель</th>
            <th style={{ textAlign: 'right' }}>Сумма</th>
          </tr>
        </thead>
        <tbody>
          {state.data.items.map((template) => (
            <tr key={template.id} data-testid="office-template">
              <td>{template.name}</td>
              <td>{KIND_LABEL[template.kind]}</td>
              <td>{templateRecipient(template)}</td>
              <td style={{ textAlign: 'right' }}>{template.amount === null ? <span className="muted">не указана</span> : <Money value={template.amount} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Autopayments({ clientId }: { clientId: string }) {
  const state = useAsync(() => officeApi.get<{ items: OfficeAutopayment[] }>(`/api/v1/office/clients/${clientId}/autopayments`), [clientId]);
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading rows={2} />;
  if (state.data.items.length === 0) return <span className="muted" data-testid="office-autopayments-empty">Автоплатежей нет</span>;
  return (
    <div className="stack gap-16" data-testid="office-autopayments">
      {state.data.items.map(({ autopayment, runs }) => {
        const note = attemptNote(autopayment);
        return (
          <div key={autopayment.id} className="stack gap-8" data-testid="office-autopayment" data-autopayment-status={autopayment.status}>
            <div className="row between wrap gap-8">
              <strong>{autopayment.templateName}</strong>
              <Pill tone={AUTOPAYMENT_STATUS_TONE[autopayment.status]}>{AUTOPAYMENT_STATUS_LABEL[autopayment.status]}</Pill>
            </div>
            <dl className="dl">
              <div><dt>Сумма</dt><dd><Money value={autopayment.amount} /></dd></div>
              <div><dt>Расписание</dt><dd>{schedulePhrase(autopayment)}</dd></div>
              <div><dt>Ближайший платёж</dt><dd>{autopayment.nextRunOn ? dateLabel(autopayment.nextRunOn) : 'не назначен'}</dd></div>
              {autopayment.endsOn ? <div><dt>Действует до</dt><dd>{dateLabel(autopayment.endsOn)}</dd></div> : null}
            </dl>
            {note ? <span className="muted">{note}</span> : null}
            {runs.length > 0 ? <RunsTable runs={runs} operationHref={(id) => `/office/operations/${id}`} /> : <span className="muted">Запусков не было</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ClientTemplates({ clientId }: { clientId: string }) {
  return (
    <>
      <section className="office-panel office-block" aria-label="Шаблоны">
        <h3>Шаблоны переводов</h3>
        <Templates clientId={clientId} />
      </section>
      <section className="office-panel office-block" aria-label="Автоплатежи">
        <h3>Автоплатежи</h3>
        <Autopayments clientId={clientId} />
      </section>
    </>
  );
}
