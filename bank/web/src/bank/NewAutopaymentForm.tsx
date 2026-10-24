import { useState, type FormEvent } from 'react';
import { ApiError, clientApi, explain } from '../lib/api';
import { templateRecipient } from '../lib/autopay-labels';
import { formatMoney, parseAmount } from '../lib/format';
import type { Autopayment, Template } from '../lib/types';

const DAYS = Array.from({ length: 28 }, (_, index) => index + 1);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Errors = Partial<Record<'template' | 'amount' | 'endsOn', string>>;

export function NewAutopaymentForm({ templates, onCreated, onCancel }: { templates: Template[]; onCreated: (autopayment: Autopayment) => void; onCancel: () => void }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [day, setDay] = useState(1);
  const [amountText, setAmountText] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const template = templates.find((item) => item.id === templateId);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Errors = {};
    const amount = amountText.trim() === '' ? null : parseAmount(amountText);
    if (!template) found.template = 'Выберите шаблон';
    if (amountText.trim() !== '' && amount === null) found.amount = 'Введите сумму больше нуля, например 1500 или 1500,50';
    if (amountText.trim() === '' && template?.amount === null) found.amount = 'У шаблона нет суммы — укажите её';
    if (endsOn !== '' && !DATE_PATTERN.test(endsOn)) found.endsOn = 'Выберите дату';
    setErrors(found);
    setGeneral(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const created = await clientApi.post<Autopayment>('/api/v1/autopayments', {
        templateId,
        dayOfMonth: day,
        ...(amount === null ? {} : { amount }),
        ...(endsOn === '' ? {} : { endsOn }),
      });
      onCreated(created);
    } catch (error) {
      if (error instanceof ApiError && error.details[0]?.field === 'body.endsOn') setErrors({ endsOn: error.details[0].message });
      else setGeneral(explain(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card panel" onSubmit={onSubmit} noValidate data-testid="new-autopayment-form">
      <h3 style={{ fontSize: 17, fontWeight: 700 }}>Новый автоплатёж</h3>
      <div className="field">
        <label htmlFor="ap-template">Шаблон</label>
        <select id="ap-template" className="input" value={templateId} onChange={(event) => setTemplateId(event.target.value)} data-testid="ap-template">
          {templates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {templateRecipient(item)}
            </option>
          ))}
        </select>
        {errors.template ? <span className="field-error" role="alert">{errors.template}</span> : null}
      </div>
      <div className="field">
        <label htmlFor="ap-day">Число месяца</label>
        <select id="ap-day" className="input" value={day} onChange={(event) => setDay(Number(event.target.value))} data-testid="ap-day">
          {DAYS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <span className="field-hint">Платёж проходит в 10:00 по времени банка. Дальше 28-го числа выбрать нельзя.</span>
      </div>
      <div className="field">
        <label htmlFor="ap-amount">Сумма</label>
        <input id="ap-amount" className={`input input-mono${errors.amount ? ' input-invalid' : ''}`} inputMode="decimal" placeholder={template?.amount == null ? '0 ₽' : `${formatMoney(template.amount)} — из шаблона`} value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-invalid={errors.amount ? true : undefined} data-testid="ap-amount" />
        {errors.amount ? <span className="field-error" role="alert" data-testid="error-ap-amount">{errors.amount}</span> : null}
      </div>
      <div className="field">
        <label htmlFor="ap-ends">Действует до (необязательно)</label>
        <input id="ap-ends" type="date" className={`input${errors.endsOn ? ' input-invalid' : ''}`} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} aria-invalid={errors.endsOn ? true : undefined} data-testid="ap-ends" />
        {errors.endsOn ? <span className="field-error" role="alert" data-testid="error-ap-ends">{errors.endsOn}</span> : null}
      </div>
      {general ? <p className="field-error" role="alert" data-testid="ap-error">{general}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="ap-submit">
          {busy ? 'Создаём…' : 'Создать автоплатёж'}
        </button>
        <button type="button" className="btn" onClick={onCancel} data-testid="ap-cancel">
          Отмена
        </button>
      </div>
    </form>
  );
}
