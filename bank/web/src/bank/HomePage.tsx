import { Link } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/States';
import { bankNowMs, moscowHour } from '../lib/bank-time';
import { clientApi } from '../lib/api';
import { formatMoney, greeting } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { releaseAtLeast, useBankRelease } from '../lib/release';
import { isActive } from '../lib/status';
import type { Account, Operation, Page } from '../lib/types';
import { AccountTiles } from './AccountTiles';
import { LimitsCard } from './LimitsCard';
import { OperationList } from './OperationList';
import { useProfile } from './profile-context';
import { TemplatesCard } from './TemplatesCard';

interface HomeData {
  accounts: Account[];
  operations: Page<Operation>;
}

export function HomePage() {
  useDocumentTitle('Главная · ЗапускБанк');
  const { profile } = useProfile();
  const release = useBankRelease();
  const state = useAsync<HomeData>(
    async () => ({
      accounts: (await clientApi.get<{ items: Account[] }>('/api/v1/accounts')).items,
      operations: await clientApi.get<Page<Operation>>('/api/v1/operations', { limit: 8 }),
    }),
    [],
    4000,
    (data) => data.operations.items.some((operation) => isActive(operation.status)),
  );
  const firstName = profile.fullName.split(' ')[0] ?? profile.fullName;
  const reviewing = state.data?.operations.items.find((operation) => operation.status === 'ON_REVIEW') ?? null;

  return (
    <main className="bank-page">
      <div className="bank-col">
        <h1 className="page-title" data-testid="greeting">
          {greeting(moscowHour(bankNowMs()))}, {firstName}
        </h1>
        {state.data ? <AccountTiles accounts={state.data.accounts} reviewing={reviewing !== null} /> : null}
        <section aria-label="Быстрые действия" className="quick">
          <Link to="/transfer" className="btn btn-primary" data-testid="quick-phone-transfer">
            Перевод по номеру телефона
          </Link>
          {state.data && state.data.accounts.length > 1 ? (
            <Link to="/transfer?mode=own" className="btn" data-testid="quick-own-transfer">
              Между своими счетами
            </Link>
          ) : null}
          <Link to="/statement" className="btn" data-testid="quick-statement">
            Выписка
          </Link>
        </section>
        {releaseAtLeast(release, '1.1') ? <TemplatesCard /> : null}
        <section aria-label="Последние операции" className="card ops">
          <div className="ops-head">
            <h2>Операции</h2>
            <Link to="/history" data-testid="link-history" style={{ fontWeight: 600 }}>
              Вся история
            </Link>
          </div>
          {state.data ? (
            state.data.operations.items.length > 0 ? (
              <OperationList operations={state.data.operations.items} />
            ) : (
              <div className="state" data-testid="empty">
                Операций пока нет
              </div>
            )
          ) : state.error ? (
            <ErrorBox error={state.error} onRetry={state.reload} />
          ) : (
            <Loading />
          )}
        </section>
      </div>
      <aside className="bank-aside">
        {reviewing ? (
          <div className="notice notice-warn" role="status" data-testid="review-notice">
            <div className="notice-title" style={{ color: 'var(--warn)' }}>
              Перевод на проверке
            </div>
            <div style={{ fontSize: 14 }}>
              {formatMoney(reviewing.amount)} {reviewing.recipient.displayName ? `— ${reviewing.recipient.displayName}` : ''} проверяем обычно до 30 минут. Деньги заморожены на счёте.
            </div>
            <Link to={`/operations/${reviewing.id}`} style={{ fontSize: 14, fontWeight: 600 }} data-testid="review-notice-link">
              Открыть операцию
            </Link>
          </div>
        ) : null}
        <LimitsCard profile={profile} />
      </aside>
    </main>
  );
}
