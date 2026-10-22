import { Link, NavLink, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BrandMark } from '../components/Brand';
import { Footer } from '../components/Footer';
import { ErrorBox, Loading } from '../components/States';
import { fullDate } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import type { BankDocument, DocumentIndex } from '../lib/types';

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Документ не найден');
  return (await response.json()) as T;
}

export function DocsPage() {
  const { slug } = useParams();
  const index = useAsync(() => fetchJson<DocumentIndex>('/docs-content'), []);
  const current = slug ?? index.data?.documents[0]?.slug ?? null;
  const document = useAsync(() => (current ? fetchJson<BankDocument>(`/docs-content/${current}`) : Promise.resolve(null)), [current]);
  useDocumentTitle(document.data ? `${document.data.title} · документация ЗапускБанка` : 'Документация · ЗапускБанк');

  return (
    <div className="app">
      <header className="bank-header">
        <div className="bank-header-inner">
          <Link to="/" className="brand" data-testid="brand">
            <BrandMark />
            <span className="brand-name">ЗапускБанк · Документация</span>
          </Link>
          <nav className="bank-nav" aria-label="Разделы">
            <a href="/" data-testid="docs-to-bank">Интернет-банк</a>
            <a href="/office" data-testid="docs-to-office">Операционный офис</a>
          </nav>
        </div>
      </header>
      <div className="app-main">
        <div className="docs-layout">
          <nav className="card docs-nav" aria-label="Документы" data-testid="docs-nav">
            {index.data?.documents.map((item) => (
              <NavLink key={item.slug} to={`/docs/${item.slug}`} className={({ isActive }) => (isActive || (!slug && item.slug === current) ? 'active' : '')} data-testid="docs-link">
                <span>{item.title}</span>
                <span className="muted mono" style={{ fontSize: 12 }}>{item.version}</span>
              </NavLink>
            ))}
            {index.data?.specs.map((spec) => (
              <a key={spec.id} href={spec.href} target="_blank" rel="noreferrer" data-testid="docs-spec-link">
                <span>{spec.title}</span>
                <span className="muted mono" style={{ fontSize: 12 }}>{spec.version}</span>
              </a>
            ))}
            {index.error ? <ErrorBox error={index.error} onRetry={index.reload} /> : null}
          </nav>
          <article className="card docs-body" data-testid="docs-body">
            {document.data ? (
              <>
                <div className="docs-meta">
                  <span data-testid="docs-version">Версия документа {document.data.version}</span>
                  <span>обновлён {fullDate(document.data.updated)}</span>
                </div>
                <div className="markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{document.data.markdown}</Markdown>
                </div>
              </>
            ) : document.error ? (
              <ErrorBox error={document.error} onRetry={document.reload} />
            ) : (
              <Loading rows={6} />
            )}
          </article>
        </div>
      </div>
      <Footer />
    </div>
  );
}
