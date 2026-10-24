import { Link } from 'react-router-dom';

export function ScreenHead({ title, back = '/' }: { title: string; back?: string }) {
  return (
    <div className="screen-head">
      <div className="screen-head-inner">
        <Link to={back} className="back" aria-label="Назад" data-testid="back">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 L8 12 L15 19" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <h1>{title}</h1>
      </div>
    </div>
  );
}
