import { useState, type FormEvent } from 'react';
import { ApiError, clientApi, explain } from '../lib/api';
import type { Operation, Template } from '../lib/types';

const NAME_MAX = 40;

export function SaveAsTemplate({ operation, onSaved }: { operation: Operation; onSaved: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(operation.type === 'PHONE_TRANSFER' ? (operation.recipient.displayName ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      setError(`Название — от 1 до ${NAME_MAX} символов`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await clientApi.post<Template>('/api/v1/templates', { name: trimmed, fromOperationId: operation.id });
      setOpen(false);
      onSaved(`Шаблон «${created.name}» сохранён`);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === 'TEMPLATE_NAME_TAKEN' ? caught.message : explain(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="save-template">
        Сохранить как шаблон
      </button>
    );
  }
  return (
    <form className="card panel" onSubmit={onSubmit} noValidate data-testid="save-template-form">
      <div className="field">
        <label htmlFor="save-template-name">Название шаблона</label>
        <input id="save-template-name" className={`input${error ? ' input-invalid' : ''}`} maxLength={NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={error ? true : undefined} data-testid="save-template-name" />
        {error ? (
          <span className="field-error" role="alert" data-testid="save-template-error">
            {error}
          </span>
        ) : null}
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="save-template-submit">
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)} data-testid="save-template-cancel">
          Отмена
        </button>
      </div>
    </form>
  );
}
