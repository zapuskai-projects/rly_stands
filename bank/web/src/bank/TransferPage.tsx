import { Link, useSearchParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { clientApi } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { Account, Bank } from '../lib/types';
import { OwnTransferForm } from './OwnTransferForm';
import { PhoneTransferForm } from './PhoneTransferForm';
import { useProfile } from './profile-context';

export function TransferPage() {
  useDocumentTitle('Перевод · ЗапускБанк');
  const { profile } = useProfile();
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode') === 'own' ? 'own' : 'phone';
  const state = useAsync(async () => ({
    accounts: (await clientApi.get<{ items: Account[] }>('/api/v1/accounts')).items,
    banks: (await clientApi.get<{ items: Bank[] }>('/api/v1/banks')).items,
  }), []);

  const select = (next: 'phone' | 'own') => setParams(next === 'own' ? { mode: 'own' } : {}, { replace: true });

  return (
    <>
      <div className="screen-head">
        <div className="screen-head-inner">
          <Link to="/" className="back" aria-label="Назад" data-testid="back">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5 L8 12 L15 19" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1>{mode === 'own' ? 'Между своими счетами' : 'Перевод по номеру телефона'}</h1>
        </div>
      </div>
      <main className="form-page">
        <div className="seg" role="group" aria-label="Вид перевода">
          <button type="button" aria-pressed={mode === 'phone'} onClick={() => select('phone')} data-testid="mode-phone">
            По телефону
          </button>
          <button type="button" aria-pressed={mode === 'own'} onClick={() => select('own')} data-testid="mode-own">
            Между счетами
          </button>
        </div>
        {state.data ? (
          mode === 'own' ? (
            state.data.accounts.length > 1 ? (
              <OwnTransferForm accounts={state.data.accounts} />
            ) : (
              <div className="state card" data-testid="own-unavailable">
                Для перевода между своими счетами нужно хотя бы два счёта.
              </div>
            )
          ) : (
            <PhoneTransferForm accounts={state.data.accounts} banks={state.data.banks} profile={profile} />
          )
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={5} />
        )}
      </main>
    </>
  );
}
