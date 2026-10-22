import { explain } from '../lib/api';

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack gap-12" style={{ padding: 20 }} role="status" aria-label="Загрузка" data-testid="loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: 22, width: `${90 - index * 15}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state" role="alert" data-testid="error-box">
      <p>{explain(error)}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry} data-testid="retry" style={{ marginTop: 12 }}>
          Повторить
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="state" data-testid="empty">
      {children}
    </div>
  );
}
