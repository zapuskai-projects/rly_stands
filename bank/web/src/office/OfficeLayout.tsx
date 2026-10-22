import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/Brand';
import { Footer } from '../components/Footer';
import { ErrorBox, Loading } from '../components/States';
import { officeApi, setToken } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { ROLE_LABEL } from '../lib/office-labels';
import type { Operator, Page, ReviewItem } from '../lib/types';
import { OperatorContext, type OfficeOutletContext } from './office-context';

export function OfficeLayout() {
  const navigate = useNavigate();
  const operator = useAsync(() => officeApi.get<Operator>('/api/v1/office/me'), []);
  const pending = useAsync(() => officeApi.get<Page<ReviewItem>>('/api/v1/office/reviews', { state: 'PENDING', limit: 1 }), [], 8000);

  const logout = async () => {
    try {
      await officeApi.post('/api/v1/office/auth/logout');
    } finally {
      setToken('office', null);
      navigate('/office/login');
    }
  };

  return (
    <div className="office">
      <header className="office-header">
        <div className="office-header-inner">
          <div className="row gap-8">
            <BrandMark size={28} />
            <span style={{ fontWeight: 800 }}>ЗапускБанк · Операционный офис</span>
          </div>
          <nav className="office-nav" aria-label="Разделы офиса">
            <NavLink to="/office" end data-testid="office-nav-reviews">
              Ручная проверка
              {pending.data && pending.data.total > 0 ? (
                <span className="badge-count" data-testid="pending-count">
                  {pending.data.total}
                </span>
              ) : null}
            </NavLink>
            <NavLink to="/office/clients" data-testid="office-nav-clients">Клиенты</NavLink>
            <NavLink to="/office/operations" data-testid="office-nav-operations">Операции</NavLink>
            <NavLink to="/office/tariffs" data-testid="office-nav-tariffs">Тарифы и лимиты</NavLink>
            <NavLink to="/office/notifications" data-testid="office-nav-notifications">Уведомления</NavLink>
          </nav>
          <div className="office-user">
            {operator.data ? (
              <span data-testid="operator-name">
                {ROLE_LABEL[operator.data.role]}: {operator.data.shortName}
              </span>
            ) : null}
            <button type="button" className="link-button" onClick={() => void logout()} data-testid="office-logout">
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className="office-main">
        {operator.data ? (
          <OperatorContext.Provider value={operator.data}>
            <Outlet context={{ reloadPending: pending.reload } satisfies OfficeOutletContext} />
          </OperatorContext.Provider>
        ) : operator.error ? (
          <ErrorBox error={operator.error} onRetry={operator.reload} />
        ) : (
          <Loading rows={4} />
        )}
      </main>
      <Footer />
    </div>
  );
}
