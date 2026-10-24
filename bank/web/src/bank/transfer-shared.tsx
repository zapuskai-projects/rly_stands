import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, clientApi, explain, newKey, type FieldIssue } from '../lib/api';
import { formatMoney, lastDigits } from '../lib/format';
import type { Account, Operation } from '../lib/types';

export function accountLabel(account: Account): string {
  const card = account.cards[0];
  const name = card ? `Карта «${card.product}» •• ${lastDigits(card.maskedNumber)}` : account.title;
  return `${name} · ${formatMoney(account.available)}`;
}

export function AccountSelect({ id, label, accounts, value, onChange, exclude, testId }: {
  id: string;
  label: string;
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  exclude?: string;
  testId: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId}>
        {accounts
          .filter((account) => account.id !== exclude)
          .map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account)}
            </option>
          ))}
      </select>
    </div>
  );
}

export type FieldErrors = Partial<Record<'phone' | 'amount' | 'comment' | 'from' | 'to', string>>;

const FIELD_BY_CODE: Record<string, keyof FieldErrors> = {
  INSUFFICIENT_FUNDS: 'amount',
  AMOUNT_REQUIRED: 'amount',
  RECIPIENT_NOT_FOUND: 'phone',
  RECIPIENT_IS_SENDER: 'phone',
  UNKNOWN_BANK: 'phone',
  SAME_ACCOUNT: 'to',
};

const FIELD_BY_PATH: Record<string, keyof FieldErrors> = {
  'body.recipientPhone': 'phone',
  'body.amount': 'amount',
  'body.comment': 'comment',
  'body.fromAccount': 'from',
  'body.toAccount': 'to',
};

export function mapSubmitError(error: unknown): { fields: FieldErrors; general: string | null } {
  if (error instanceof ApiError) {
    const byCode = FIELD_BY_CODE[error.code];
    if (byCode) return { fields: { [byCode]: error.message }, general: null };
    const fields: FieldErrors = {};
    for (const issue of error.details as FieldIssue[]) {
      const key = FIELD_BY_PATH[issue.field];
      if (key) fields[key] = issue.message;
    }
    if (Object.keys(fields).length > 0) return { fields, general: null };
  }
  return { fields: {}, general: explain(error) };
}

export function useTransferSubmit(path = '/api/v1/transfers') {
  const navigate = useNavigate();
  const keyRef = useRef<{ signature: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (body: Record<string, unknown>): Promise<{ fields: FieldErrors; general: string | null } | null> => {
    const signature = JSON.stringify(body);
    if (!keyRef.current || keyRef.current.signature !== signature) keyRef.current = { signature, key: newKey('web') };
    setBusy(true);
    try {
      const operation = await clientApi.post<Operation>(path, body, { 'Idempotency-Key': keyRef.current.key });
      navigate(`/operations/${operation.id}`);
      return null;
    } catch (error) {
      return mapSubmitError(error);
    } finally {
      setBusy(false);
    }
  };
  return { submit, busy };
}
