import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { Footer } from '../components/Footer';
import { ApiError, clientApi, explain, setToken } from '../lib/api';
import { normalizePhone, timeOf } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { smsViews } from '../lib/sms';
import type { SmsMessage } from '../lib/types';

interface Challenge {
  challengeId: string;
  expiresInSec: number;
}

interface Token {
  accessToken: string;
}

function PhoneEmulator({ phone, onFill }: { phone: string | null; onFill: (code: string) => void }) {
  const [messages, setMessages] = useState<SmsMessage[]>([]);

  useEffect(() => {
    if (!phone) {
      setMessages([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await clientApi.anonymous<{ items: SmsMessage[] }>('GET', '/api/v1/sandbox/sms', { query: { phone, limit: 3 } });
        if (!cancelled) setMessages(result.items);
      } catch {
        if (!cancelled) setMessages([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phone]);

  return (
    <aside className="card phone-box" aria-label="СМС на этот номер" data-testid="sms-emulator">
      <h2>СМС на этот номер · учебный телефон</h2>
      {!phone ? <p style={{ color: '#9db0c2', fontSize: 14 }}>Введите номер телефона клиента, и здесь появятся его СМС с кодом входа.</p> : null}
      {phone && messages.length === 0 ? <p style={{ color: '#9db0c2', fontSize: 14 }}>СМС пока нет. Нажмите «Получить код».</p> : null}
      {smsViews(messages).map(({ message, code, canFill, replaced }) => (
        <div key={message.id} className="sms" data-testid="sms-message">
          <div className="sms-time">{timeOf(message.createdAt)}</div>
          <div>{message.text}</div>
          {canFill && code ? (
            <button type="button" className="link-button" style={{ color: '#7fd1de', padding: '4px 0' }} onClick={() => onFill(code)} data-testid="sms-fill-code">
              Подставить код
            </button>
          ) : null}
          {replaced ? <div style={{ color: '#9db0c2', fontSize: 13, paddingTop: 4 }}>Код заменён новым</div> : null}
        </div>
      ))}
    </aside>
  );
}

export function LoginPage() {
  useDocumentTitle('Вход · ЗапускБанк');
  const navigate = useNavigate();
  const location = useLocation();
  const [phoneText, setPhoneText] = useState('+7 900 111-00-01');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const phone = normalizePhone(phoneText);

  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);

  const requestCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!phone) {
      setError('Введите мобильный номер в формате +7 900 000-00-00');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setChallenge(await clientApi.anonymous<Challenge>('POST', '/api/v1/auth/login', { body: { phone } }));
      setCode('');
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === 'CLIENT_NOT_FOUND' ? 'Клиент с таким номером не найден' : explain(caught));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Код состоит из шести цифр');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await clientApi.anonymous<Token>('POST', '/api/v1/auth/verify', { body: { challengeId: challenge.challengeId, code } });
      setToken('client', token.accessToken);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="app-main">
        <div className="login-wrap">
          <form className="card login-card" onSubmit={challenge ? verify : requestCode} data-testid="login-form">
            <Brand />
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>Вход в интернет-банк</h1>
            <div className="field">
              <label htmlFor="login-phone">Телефон</label>
              <input
                id="login-phone"
                className="input input-mono"
                type="tel"
                autoComplete="tel"
                value={phoneText}
                disabled={challenge !== null}
                onChange={(event) => setPhoneText(event.target.value)}
                data-testid="login-phone"
              />
            </div>
            {challenge ? (
              <div className="field">
                <label htmlFor="login-code">Код из СМС</label>
                <input
                  id="login-code"
                  ref={codeRef}
                  className="input input-mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  data-testid="login-code"
                />
                <span className="field-hint">Код действует {Math.round(challenge.expiresInSec / 60)} минут. Новый запрос отменяет прежний код.</span>
              </div>
            ) : null}
            {error ? (
              <p className="field-error" role="alert" data-testid="login-error">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy} data-testid={challenge ? 'login-verify' : 'login-request'}>
              {busy ? 'Подождите…' : challenge ? 'Войти' : 'Получить код'}
            </button>
            {challenge ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setChallenge(null);
                  setError(null);
                }}
                data-testid="login-change-phone"
              >
                Другой номер или новый код
              </button>
            ) : null}
            <a href="/office" data-testid="login-to-office" style={{ fontSize: 13 }}>
              Вход для сотрудников банка
            </a>
          </form>
          <PhoneEmulator phone={phone} onFill={setCode} />
        </div>
      </div>
      <Footer />
    </div>
  );
}
