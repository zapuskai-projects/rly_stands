import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { ApiError, clientApi, explain } from '../lib/api';
import { templateRecipient } from '../lib/autopay-labels';
import { formatAmountShort, parseAmount } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Template } from '../lib/types';
import { ScreenHead } from './ScreenHead';

const NAME_MAX = 40;

function EditForm({ template }: { template: Template }) {
  const navigate = useNavigate();
  const [name, setName] = useState(template.name);
  const [amountText, setAmountText] = useState(template.amount === null ? '' : formatAmountShort(template.amount));
  const [comment, setComment] = useState(template.comment ?? '');
  const [errors, setErrors] = useState<{ name?: string; amount?: string }>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: { name?: string; amount?: string } = {};
    const trimmed = name.trim();
    const amount = amountText.trim() === '' ? null : parseAmount(amountText);
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) found.name = `Название — от 1 до ${NAME_MAX} символов`;
    if (amountText.trim() !== '' && amount === null) found.amount = 'Введите сумму больше нуля или оставьте поле пустым';
    setErrors(found);
    setGeneral(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await clientApi.patch(`/api/v1/templates/${template.id}`, { name: trimmed, amount, comment: comment.trim() ? comment.trim() : null });
      navigate('/');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TEMPLATE_NAME_TAKEN') setErrors({ name: error.message });
      else setGeneral(explain(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack gap-16" onSubmit={onSubmit} noValidate data-testid="template-edit-form">
      <div className="form-panel">
        <div className="field">
          <label htmlFor="template-name">Название</label>
          <input id="template-name" className={`input${errors.name ? ' input-invalid' : ''}`} maxLength={NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={errors.name ? true : undefined} data-testid="template-name-input" />
          {errors.name ? (
            <span className="field-error" role="alert" data-testid="error-template-name">
              {errors.name}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="template-amount">Сумма</label>
          <input id="template-amount" className={`input input-mono${errors.amount ? ' input-invalid' : ''}`} inputMode="decimal" placeholder="Не указана — спросим при переводе" value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-invalid={errors.amount ? true : undefined} data-testid="template-amount-input" />
          {errors.amount ? (
            <span className="field-error" role="alert" data-testid="error-template-amount">
              {errors.amount}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="template-comment">Сообщение получателю</label>
          <input id="template-comment" className="input" maxLength={140} value={comment} onChange={(event) => setComment(event.target.value)} data-testid="template-comment-input" />
        </div>
        <p className="muted" style={{ fontSize: 14 }}>
          Получатель: {templateRecipient(template)}. Чтобы перевести другому человеку, создайте новый шаблон из выполненной операции.
        </p>
        {general ? (
          <p className="field-error" role="alert" data-testid="template-edit-error">
            {general}
          </p>
        ) : null}
      </div>
      <div className="sticky-action">
        <div className="sticky-action-inner">
          <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid="template-save">
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </form>
  );
}

export function TemplateEditPage() {
  useDocumentTitle('Изменить шаблон · ЗапускБанк');
  const { id = '' } = useParams();
  const state = useAsync(() => clientApi.get<{ items: Template[] }>('/api/v1/templates'), []);
  const template = state.data?.items.find((item) => item.id === id) ?? null;
  return (
    <>
      <ScreenHead title="Изменить шаблон" />
      <main className="form-page">
        {template ? (
          <EditForm template={template} />
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
