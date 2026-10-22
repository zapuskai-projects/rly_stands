import { formatAmountShort, formatMoney, parseAmount } from '../lib/format';
import type { FieldErrors } from './transfer-shared';

export function AmountField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  const normalize = () => {
    const parsed = parseAmount(value);
    if (parsed !== null) onChange(formatAmountShort(parsed));
  };
  return (
    <div className="field">
      <label htmlFor="amount">Сумма</label>
      <input
        id="amount"
        className={`input input-mono amount-input${error ? ' input-invalid' : ''}`}
        type="text"
        inputMode="decimal"
        placeholder="0 ₽"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={normalize}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'amount-error' : undefined}
        data-testid="transfer-amount"
      />
      {error ? (
        <span id="amount-error" className="field-error" role="alert" data-testid="error-amount">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function CommentField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <div className="field">
      <label htmlFor="comment">Сообщение получателю</label>
      <input id="comment" className="input" type="text" maxLength={140} value={value} onChange={(event) => onChange(event.target.value)} data-testid="transfer-comment" />
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function SummaryRow({ title, value, testId }: { title: string; value: string; testId: string }) {
  return (
    <div>
      <dt>{title}</dt>
      <dd className="mono" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function submitLabel(kopecks: number | null): string {
  if (kopecks === null) return 'Перевести';
  return `Перевести ${kopecks % 100 === 0 ? `${(kopecks / 100).toLocaleString('ru-RU')} ₽` : formatMoney(kopecks)}`;
}

export function firstError(errors: FieldErrors): string | null {
  return errors.phone ?? errors.amount ?? errors.to ?? errors.comment ?? errors.from ?? null;
}
