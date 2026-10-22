import { useState, type FormEvent } from 'react';
import { ErrorBox, Loading } from '../components/States';
import { Toast } from '../components/Toast';
import { explain, officeApi } from '../lib/api';
import { bpsToPercentText, formatWholeRubles, kopecksToInput, parseAmountOrZero, parsePercent } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Tariff } from '../lib/types';
import { useOperator } from './office-context';

interface Draft {
  daily: string;
  free: string;
  rate: string;
  min: string;
  max: string;
}

function toDraft(tariff: Tariff): Draft {
  return {
    daily: kopecksToInput(tariff.dailyPhoneTransferLimit),
    free: kopecksToInput(tariff.freeMonthlyVolume),
    rate: bpsToPercentText(tariff.commissionRateBps),
    min: kopecksToInput(tariff.commissionMin),
    max: kopecksToInput(tariff.commissionMax),
  };
}

function TariffCard({ tariff, onSaved }: { tariff: Tariff; onSaved: (message: string) => void }) {
  const operator = useOperator();
  const senior = operator.role === 'SENIOR';
  const [draft, setDraft] = useState<Draft>(() => toDraft(tariff));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const original = toDraft(tariff);
  const changed = (Object.keys(draft) as (keyof Draft)[]).some((key) => draft[key] !== original[key]);
  const set = (key: keyof Draft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const values = {
      dailyPhoneTransferLimit: parseAmountOrZero(draft.daily),
      freeMonthlyVolume: parseAmountOrZero(draft.free),
      commissionRateBps: parsePercent(draft.rate),
      commissionMin: parseAmountOrZero(draft.min),
      commissionMax: parseAmountOrZero(draft.max),
    };
    if (Object.values(values).some((value) => value === null)) {
      setError('Проверьте поля: суммы в рублях, ставка в процентах от 0 до 100');
      return;
    }
    if ((values.commissionMin as number) > (values.commissionMax as number)) {
      setError('Минимальная комиссия не может быть больше максимальной');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await officeApi.put(`/api/v1/office/tariffs/${tariff.code}`, values);
      onSaved(`Тариф «${tariff.name}» сохранён`);
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof Draft, label: string, unit: string, testId: string) => (
    <div className="field">
      <label htmlFor={`${tariff.code}-${key}`}>{label}</label>
      <div className="row gap-8">
        <input id={`${tariff.code}-${key}`} className="input input-mono" value={draft[key]} disabled={!senior} onChange={(event) => set(key)(event.target.value)} data-testid={`${tariff.code}-${testId}`} />
        <span className="muted">{unit}</span>
      </div>
    </div>
  );

  return (
    <form className="office-panel office-block" onSubmit={save} data-testid="tariff-card" data-tariff={tariff.code}>
      <div className="row between">
        <h3 style={{ fontSize: 17 }}>Тариф «{tariff.name}»</h3>
        <span className="muted mono">{tariff.code}</span>
      </div>
      <div className="tariff-form">
        {field('daily', 'Суточный лимит переводов по телефону', '₽', 'daily')}
        {field('free', 'Бесплатный объём переводов в другие банки в месяц', '₽', 'free')}
        {field('rate', 'Комиссия сверх бесплатного объёма', '%', 'rate')}
        {field('min', 'Минимум комиссии', '₽', 'min')}
        {field('max', 'Максимум комиссии', '₽', 'max')}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Сейчас: лимит {formatWholeRubles(tariff.dailyPhoneTransferLimit)} в сутки, без комиссии до {formatWholeRubles(tariff.freeMonthlyVolume)} в месяц.
      </p>
      {error ? <p className="field-error" role="alert" data-testid="tariff-error">{error}</p> : null}
      {senior ? (
        <div className="decision-actions">
          <button type="button" className="btn" disabled={!changed || busy} onClick={() => setDraft(original)} data-testid="tariff-reset">Отменить правки</button>
          <button type="submit" className="btn btn-primary" disabled={!changed || busy} title={changed ? undefined : 'Измените хотя бы одно значение'} data-testid="tariff-save">
            {busy ? 'Сохраняем…' : 'Сохранить тариф'}
          </button>
        </div>
      ) : (
        <p className="muted" data-testid="tariff-readonly">Тарифы меняет старший оператор. Вы вошли как оператор.</p>
      )}
    </form>
  );
}

export function TariffsPage() {
  useDocumentTitle('Тарифы и лимиты · ЗапускБанк');
  const [toast, setToast] = useState<string | null>(null);
  const state = useAsync(async () => (await officeApi.get<{ items: Tariff[] }>('/api/v1/office/tariffs')).items, []);
  return (
    <div className="stack gap-16">
      <h1 className="office-title">Тарифы и лимиты</h1>
      {state.data ? (
        state.data.map((tariff) => (
          <TariffCard
            key={`${tariff.code}-${tariff.dailyPhoneTransferLimit}-${tariff.freeMonthlyVolume}-${tariff.commissionRateBps}-${tariff.commissionMin}-${tariff.commissionMax}`}
            tariff={tariff}
            onSaved={(message) => {
              setToast(message);
              state.reload();
            }}
          />
        ))
      ) : state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : (
        <Loading rows={5} />
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
