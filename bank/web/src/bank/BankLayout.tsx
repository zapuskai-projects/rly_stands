import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { Avatar } from '../components/Avatar';
import { ErrorBox, Loading } from '../components/States';
import { Footer } from '../components/Footer';
import { clientApi, setToken } from '../lib/api';
import { useAsync } from '../lib/hooks';
import type { Profile } from '../lib/types';
import { ProfileContext } from './profile-context';

const NAV = [
  { to: '/', label: 'Главная', testId: 'nav-home', end: true },
  { to: '/transfer', label: 'Переводы', testId: 'nav-transfer', end: false },
  { to: '/history', label: 'История', testId: 'nav-history', end: false },
  { to: '/statement', label: 'Выписка', testId: 'nav-statement', end: false },
];

export function BankLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const flow = pathname.startsWith('/transfer') || pathname.startsWith('/operations/');
  const state = useAsync(() => clientApi.get<Profile>('/api/v1/me'), []);

  const logout = async () => {
    try {
      await clientApi.post('/api/v1/auth/logout');
    } finally {
      setToken('client', null);
      navigate('/login');
    }
  };

  return (
    <div className={`app${flow ? ' flow' : ''}`}>
      <header className="bank-header">
        <div className="bank-header-inner">
          <Brand />
          <nav className="bank-nav" aria-label="Разделы">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} data-testid={item.testId} className={({ isActive }) => (isActive ? 'active' : '')}>
                {item.label}
              </NavLink>
            ))}
            <a href="/docs" data-testid="nav-docs">
              Документация
            </a>
          </nav>
          <div className="bank-user">
            {state.data ? (
              <>
                <Avatar name={state.data.fullName} />
                <span style={{ fontWeight: 600 }} data-testid="user-name">
                  {state.data.fullName}
                </span>
              </>
            ) : null}
            <button type="button" className="link-button" onClick={() => void logout()} data-testid="logout">
              Выйти
            </button>
          </div>
        </div>
      </header>
      <div className="app-main">
        {state.data ? (
          <ProfileContext.Provider value={{ profile: state.data, reload: state.reload }}>
            <Outlet />
          </ProfileContext.Provider>
        ) : state.error ? (
          <ErrorBox error={state.error} onRetry={state.reload} />
        ) : (
          <Loading rows={4} />
        )}
      </div>
      <Footer />
    </div>
  );
}
