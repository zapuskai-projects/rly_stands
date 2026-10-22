import { useEffect, useState, type FormEvent } from 'react';
import { Avatar } from '../components/Avatar';
import { ApiError, clientApi } from '../lib/api';
import { previewFee } from '../lib/fee';
import { formatMoney, formatWholeRubles, normalizePhone, parseAmount } from '../lib/format';
import type { Account, Bank, Profile, RecipientLookup } from '../lib/types';
import { AmountField, CommentField, SummaryRow, submitLabel } from './AmountFields';
import { AccountSelect, useTransferSubmit, type FieldErrors } from './transfer-shared';

const OWN_BANK = 'ZAPUSK';

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; data: RecipientLookup } | { state: 'error'; message: string };

function useRecipientLookup(phone: string | null, bankCode: string): Lookup {
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  useEffect(() => {
    if (!phone) {
      setLookup({ state: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setLookup({ state: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const data = await clientApi.get<RecipientLookup>('/api/v1/recipients/lookup', { phone, bankCode });
        if (!cancelled) setLookup({ state: 'ok', data });
      } catch (error) {
        if (!cancelled) setLookup({ state: 'error', message: error instanceof ApiError ? error.message : 'Не удалось найти получателя' });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone, bankCode]);
  return lookup;
}

function RecipientCard({ lookup }: { lookup: Lookup }) {
  if (lookup.state === 'idle') return null;
  if (lookup.state === 'loading') return <div className="recipient-card muted" data-testid="recipient-loading">Ищем получателя…</div>;
  if (lookup.state === 'error') {
    return (
      <span className="field-error" role="alert" data-testid="error-phone">
        {lookup.message}
      </span>
    );
  }
  const { data } = lookup;
  return (
    <div className="recipient-card" data-testid="recipient-card">
      <Avatar name={data.displayName ?? '??'} tone={data.known ? 'neutral' : 'warn'} />
      <div className="stack">
        <span style={{ fontWeight: 600 }} data-testid="recipient-name">
          {data.displayName ?? 'Имя получателя неизвестно'}
        </span>
        <span className="muted" style={{ fontSize: 13 }} data-testid="recipient-note">
          {data.known ? 'Вы уже переводили этому получателю' : 'Новый получатель'}
        </span>
      </div>
    </div>
  );
}

export function PhoneTransferForm({ accounts, banks, profile }: { accounts: Account[]; banks: Bank[]; profile: Profile }) {
  const [fromId, setFromId] = useState(accounts.find((account) => account.isPrimary)?.id ?? accounts[0]?.id ?? '');
  const [phoneText, setPhoneText] = useState('');
  const [bankCode, setBankCode] = useState(OWN_BANK);
  const [amountText, setAmountText] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const { submit, busy } = useTransferSubmit();

  const phone = normalizePhone(phoneText);
  const lookup = useRecipientLookup(phone, bankCode);
  const from = accounts.find((account) => account.id === fromId);
  const amount = parseAmount(amountText);
  const external = bankCode !== OWN_BANK;
  const fee = amount === null ? 0 : previewFee({ amount, route: external ? 'SBP' : 'INTERNAL', freeRemaining: profile.limits.monthlyFreeVolume.remaining, tariff: profile.tariff });

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!phone) next.phone = 'Введите мобильный номер в формате +7 900 000-00-00';
    else if (lookup.state === 'error') next.phone = lookup.message;
    if (amount === null) next.amount = 'Введите сумму больше нуля, например 1500 или 1500,50';
    else if (from && amount + fee > from.available) next.amount = `Недостаточно средств. Доступно ${formatMoney(from.available)}`;
    return next;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    setGeneral(null);
    if (Object.keys(found).length > 0) {
      document.querySelector<HTMLElement>(found.phone ? '[data-testid="transfer-phone"]' : '[data-testid="transfer-amount"]')?.focus();
      return;
    }
    const failure = await submit({
      type: 'PHONE_TRANSFER',
      fromAccount: from?.number,
      recipientPhone: phone,
      recipientBankCode: bankCode,
      amount,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (failure) {
      setErrors(failure.fields);
      setGeneral(failure.general);
    }
  };

  return (
    <form className="stack gap-16" onSubmit={onSubmit} noValidate data-testid="phone-transfer-form">
      <div className="form-panel">
        <AccountSelect id="from" label="Откуда" accounts={accounts} value={fromId} onChange={setFromId} testId="transfer-from" />
        <div className="field">
          <label htmlFor="phone">Номер телефона получателя</label>
          <input
            id="phone"
            className={`input input-mono${errors.phone ? ' input-invalid' : ''}`}
            type="tel"
            placeholder="+7 900 000-00-00"
            value={phoneText}
            onChange={(event) => setPhoneText(event.target.value)}
            aria-invalid={errors.phone ? true : undefined}
            data-testid="transfer-phone"
          />
          {errors.phone && lookup.state !== 'error' ? (
            <span className="field-error" role="alert" data-testid="error-phone">
              {errors.phone}
            </span>
          ) : null}
          <RecipientCard lookup={lookup} />
        </div>
        <div className="field">
          <label htmlFor="bank">{external ? 'Банк получателя · через СБП' : 'Банк получателя'}</label>
          <select id="bank" className="input" value={bankCode} onChange={(event) => setBankCode(event.target.value)} data-testid="transfer-bank">
            {banks.map((bank) => (
              <option key={bank.code} value={bank.code}>
                {bank.code === OWN_BANK ? bank.name : `${bank.name} (учебный)`}
              </option>
            ))}
          </select>
        </div>
        <AmountField value={amountText} onChange={setAmountText} error={errors.amount} />
        <CommentField value={comment} onChange={setComment} error={errors.comment} />
        <dl className="dl card summary">
          <SummaryRow title="Комиссия" value={formatMoney(fee)} testId="summary-fee" />
          {external ? <SummaryRow title="Без комиссии осталось" value={`${formatWholeRubles(profile.limits.monthlyFreeVolume.remaining)} в месяц`} testId="summary-free" /> : null}
          <SummaryRow title="Лимит на сегодня" value={formatWholeRubles(profile.limits.dailyPhoneTransfer.remaining)} testId="summary-daily" />
        </dl>
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
