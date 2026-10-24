import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { clientApi } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Autopayment, Template } from '../lib/types';
import { AutopaymentCard } from './AutopaymentCard';
import { NewAutopaymentForm } from './NewAutopaymentForm';

interface AutopaymentsData {
  autopayments: Autopayment[];
  templates: Template[];
}

const REFRESH_MS = 5000;

export function AutopaymentsPage() {
  useDocumentTitle('Автоплатежи · ЗапускБанк');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const state = useAsync<AutopaymentsData>(
    async () => ({
      autopayments: (await clientApi.get<{ items: Autopayment[] }>('/api/v1/autopayments')).items,
      templates: (await clientApi.get<{ items: Template[] }>('/api/v1/templates')).items,
    }),
    [],
    REFRESH_MS,
  );

  return (
    <main className="bank-page">
      <div className="bank-col">
        <div className="row between wrap gap-12">
          <h1 className="page-title">Автоплатежи</h1>
          {state.data && state.data.templates.length > 0 && !creating ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-autopayment">
              Создать автоплатёж
            </button>
          ) : null}
        </div>
        {creating && state.data ? (
          <NewAutopaymentForm
            templates={state.data.templates}
            onCancel={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false);
              setToast(`Автоплатёж «${created.templateName}» создан`);
              state.reload();
            }}
          />
        ) : null}
        {state.data ? (
          state.data.autopayments.length > 0 ? (
            <section aria-label="Автоплатежи" className="stack gap-16" data-testid="autopayment-list">
              {state.data.autopayments.map((autopayment) => (
                <AutopaymentCard key={autopayment.id} autopayment={autopayment} onChanged={state.reload} onMessage={setToast} />
              ))}
            </section>
          ) : (
            <div className="state card" data-testid="autopayments-empty">
              {state.data.templates.length > 0 ? (
                'Автоплатежей пока нет. Создайте первый из шаблона: деньги будут уходить сами в нужный день месяца.'
              ) : (
                <>
                  Автоплатёж создаётся из шаблона перевода. Откройте выполненную операцию, нажмите «Сохранить как шаблон», а потом вернитесь сюда.{' '}
                  <Link to="/history" style={{ fontWeight: 600 }}>
                    К истории операций
                  </Link>
                </>
              )}
            </div>
          )
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={4} />
        )}
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </main>
  );
}
