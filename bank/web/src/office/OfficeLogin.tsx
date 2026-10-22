import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/Brand';
import { Footer } from '../components/Footer';
import { ApiError, explain, officeApi, setToken } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';

export function OfficeLogin() {
  useDocumentTitle('Вход для сотрудников · ЗапускБанк');
  const navigate = useNavigate();
  const location = useLocation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!login.trim() || !password) {
      setError('Введите логин и пароль');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await officeApi.anonymous<{ accessToken: string }>('POST', '/api/v1/office/auth/login', { body: { login: login.trim(), password } });
      setToken('office', token.accessToken);
      navigate((location.state as { from?: string } | null)?.from ?? '/office', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401 ? 'Неверный логин или пароль' : explain(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="office">
      <form className="card office-login" onSubmit={submit} data-testid="office-login-form">
        <div className="row gap-8">
          <BrandMark size={28} />
          <span style={{ fontWeight: 800, fontSize: 16 }}>ЗапускБанк · Операционный офис</span>
        </div>
        <div className="field">
          <label htmlFor="office-login">Логин</label>
          <input id="office-login" className="input" autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} data-testid="office-login" />
        </div>
        <div className="field">
          <label htmlFor="office-password">Пароль</label>
          <input id="office-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} data-testid="office-password" />
        </div>
        {error ? (
          <p className="field-error" role="alert" data-testid="office-login-error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid="office-login-submit">
          {busy ? 'Подождите…' : 'Войти'}
        </button>
        <a href="/" style={{ fontSize: 13 }} data-testid="office-to-bank">
          Интернет-банк для клиентов
        </a>
      </form>
      <Footer />
    </div>
  );
}
