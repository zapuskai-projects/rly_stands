import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { clientApi } from '../lib/api';
import { templateRecipient } from '../lib/autopay-labels';
import { formatAccountNumber, formatAmountShort, formatMoney, parseAmount } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Template } from '../lib/types';
import { AmountField, CommentField, submitLabel } from './AmountFields';
import { ScreenHead } from './ScreenHead';
import { useTransferSubmit, type FieldErrors } from './transfer-shared';

function TransferForm({ template }: { template: Template }) {
  const [amountText, setAmountText] = useState(template.amount === null ? '' : formatAmountShort(template.amount));
  const [comment, setComment] = useState(template.comment ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const { submit, busy } = useTransferSubmit(`/api/v1/templates/${template.id}/transfers`);
  const amount = parseAmount(amountText);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setGeneral(null);
    if (amount === null) {
      setErrors({ amount: 'Введите сумму больше нуля, например 1500 или 1500,50' });
      return;
    }
    setErrors({});
    const failure = await submit({ amount, ...(comment.trim() ? { comment: comment.trim() } : {}) });
    if (failure) {
      setErrors(failure.fields);
      setGeneral(failure.general);
    }
  };

  return (
    <form className="stack gap-16" onSubmit={onSubmit} noValidate data-testid="template-transfer-form">
      <dl className="card dl details">
        <div>
          <dt>Шаблон</dt>
          <dd data-testid="template-title">{template.name}</dd>
        </div>
        <div>
          <dt>Кому</dt>
          <dd>{templateRecipient(template)}</dd>
        </div>
        <div>
          <dt>Откуда</dt>
          <dd className="mono">{formatAccountNumber(template.fromAccount)}</dd>
        </div>
        {template.amount !== null ? (
          <div>
            <dt>Сумма в шаблоне</dt>
            <dd className="mono">{formatMoney(template.amount)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="form-panel">
        <AmountField value={amountText} onChange={setAmountText} error={errors.amount} />
        <CommentField value={comment} onChange={setComment} error={errors.comment} />
        {general ? (
          <p className="field-error" role="alert" data-testid="transfer-error">
            {general}
          </p>
        ) : null}
      </div>
      <div className="sticky-action">
        <div className="sticky-action-inner">
          <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid="transfer-submit">
            {busy ? 'Отправляем…' : submitLabel(amount)}
          </button>
        </div>
      </div>
    </form>
  );
}

export function TemplateTransferPage() {
  useDocumentTitle('Перевод по шаблону · ЗапускБанк');
  const { id = '' } = useParams();
  const state = useAsync(() => clientApi.get<{ items: Template[] }>('/api/v1/templates'), []);
  const template = state.data?.items.find((item) => item.id === id) ?? null;
  return (
    <>
      <ScreenHead title="Перевод по шаблону" />
      <main className="form-page">
        {template ? (
          <TransferForm template={template} />
        ) : state.data ? (
          <div className="state card" data-testid="template-missing">
            Шаблон не найден. Возможно, его удалили.
          </div>
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={4} />
        )}
      </main>
    </>
  );
}
