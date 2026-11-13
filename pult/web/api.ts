export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly existingOperationId?: string) { super(message); }
}

export const session = { csrf: '', build: document.documentElement.dataset.build ?? '', stale: false };

export async function api<T>(path: string, options: { method?: string; body?: object; headers?: Record<string, string> } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  if (method !== 'GET' && session.stale) throw new ApiError(409, 'UI_RELOAD_REQUIRED', 'Пульт обновился. Перезагрузите страницу.');
  const headers = { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, 'X-UI-Build-Id': session.build } : {}), ...options.headers };
  const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  if (!response.ok) {
    const error = data.error ?? data;
    const code = error.code ?? data.code ?? '';
    if (code === 'UI_RELOAD_REQUIRED') session.stale = true;
    throw new ApiError(response.status, code, error.message ?? data.message ?? String(error), error.details?.existingOperationId);
  }
  return data as T;
}

export async function authenticate() {
  const hash = location.hash.slice(1);
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    const nonce = new URLSearchParams(hash).get('bootstrap') ?? hash;
    const result = await api<{ csrfToken: string }>('/api/session/bootstrap', { method: 'POST', body: { nonce } });
    session.csrf = result.csrfToken;
  } else {
    const result = await api<{ csrfToken: string }>('/api/session');
    session.csrf = result.csrfToken;
  }
}

