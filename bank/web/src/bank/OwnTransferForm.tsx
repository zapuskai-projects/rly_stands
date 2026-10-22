import { useState, type FormEvent } from 'react';
import { formatMoney, parseAmount } from '../lib/format';
import type { Account } from '../lib/types';
import { AmountField, CommentField, submitLabel } from './AmountFields';
import { AccountSelect, useTransferSubmit, type FieldErrors } from './transfer-shared';

export function OwnTransferForm({ accounts }: { accounts: Account[] }) {
  const [fromId, setFromId] = useState(accounts.find((account) => account.isPrimary)?.id ?? accounts[0]?.id ?? '');
  const [toId, setToId] = useState(accounts.find((account) => account.id !== fromId)?.id ?? '');
  const [amountText, setAmountText] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const { submit, busy } = useTransferSubmit();

  const from = accounts.find((account) => account.id === fromId);
  const to = accounts.find((account) => account.id === toId);
  const amount = parseAmount(amountText);

  const changeFrom = (value: string) => {
    setFromId(value);
    if (value === toId) setToId(accounts.find((account) => account.id !== value)?.id ?? '');
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!to) found.to = 'Выберите счёт зачисления';
    if (amount === null) found.amount = 'Введите сумму больше нуля, например 1500 или 1500,50';
    else if (from && amount > from.available) found.amount = `Недостаточно средств. Доступно ${formatMoney(from.available)}`;
    setErrors(found);
    setGeneral(null);
    if (Object.keys(found).length > 0) return;
    const failure = await submit({
      type: 'OWN_TRANSFER',
      fromAccount: from?.number,
      toAccount: to?.number,
      amount,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (failure) {
      setErrors(failure.fields);
      setGeneral(failure.general);
    }
  };

  return (
    <form className="stack gap-16" onSubmit={onSubmit} noValidate data-testid="own-transfer-form">
      <div className="form-panel">
        <AccountSelect id="from" label="Откуда" accounts={accounts} value={fromId} onChange={changeFrom} testId="transfer-from" />
        <AccountSelect id="to" label="Куда" accounts={accounts} value={toId} onChange={setToId} exclude={fromId} testId="transfer-to" />
        {errors.to ? (
          <span className="field-error" role="alert" data-testid="error-to">
            {errors.to}
          </span>
        ) : null}
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
