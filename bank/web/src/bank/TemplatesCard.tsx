import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { clientApi, explain } from '../lib/api';
import { templateRecipient } from '../lib/autopay-labels';
import { formatMoney } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { Template } from '../lib/types';

function TemplateRow({ template, confirming, busy, onAskDelete, onCancel, onDelete }: {
  template: Template;
  confirming: boolean;
  busy: boolean;
  onAskDelete: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="row-card" data-testid="template-row" data-template-name={template.name}>
      <Avatar name={template.name} tone="info" />
      <div className="op-body">
        <div className="op-title" data-testid="template-name">{template.name}</div>
        <div className="op-sub">
          {templateRecipient(template)} · {template.amount === null ? 'сумма при переводе' : formatMoney(template.amount)}
        </div>
      </div>
      <div className="row-actions">
        {confirming ? (
          <>
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={onDelete} data-testid="template-delete-confirm">
              Да, удалить
            </button>
            <button type="button" className="btn btn-small" onClick={onCancel} data-testid="template-delete-cancel">
              Не удалять
            </button>
          </>
        ) : (
          <>
            <Link to={`/templates/${template.id}/transfer`} className="btn btn-small btn-primary" data-testid="template-transfer">
              Перевести
            </Link>
            <Link to={`/templates/${template.id}/edit`} className="btn btn-small" data-testid="template-edit">
              Изменить
            </Link>
            <button type="button" className="btn btn-small" onClick={onAskDelete} data-testid="template-delete">
              Удалить
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function TemplatesCard() {
  const state = useAsync(() => clientApi.get<{ items: Template[] }>('/api/v1/templates'), []);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const remove = async (template: Template) => {
    setBusy(true);
    try {
      await clientApi.delete(`/api/v1/templates/${template.id}`);
      setToast(`Шаблон «${template.name}» удалён`);
      setConfirming(null);
      state.reload();
    } catch (error) {
      setToast(explain(error));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Шаблоны" className="card ops" data-testid="templates-card">
      <div className="ops-head">
        <h2>Шаблоны</h2>
        <Link to="/autopayments" data-testid="link-autopayments" style={{ fontWeight: 600 }}>
          Автоплатежи
        </Link>
      </div>
      {state.data ? (
        state.data.items.length > 0 ? (
          state.data.items.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              confirming={confirming === template.id}
              busy={busy}
              onAskDelete={() => setConfirming(template.id)}
              onCancel={() => setConfirming(null)}
              onDelete={() => void remove(template)}
            />
          ))
        ) : (
          <div className="state" data-testid="templates-empty">
            Шаблонов пока нет. Откройте выполненную операцию и нажмите «Сохранить как шаблон».
          </div>
        )
      ) : state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : (
        <Loading rows={2} />
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}
