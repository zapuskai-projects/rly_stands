import { Link } from 'react-router-dom';

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#0b6e7f" />
      <path d="M10 22 L22 10 M13 10 H22 V19" stroke="#ffffff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ to = '/', suffix }: { to?: string; suffix?: string }) {
  return (
    <Link to={to} className="brand" data-testid="brand">
      <BrandMark />
      <span className="brand-name">ЗапускБанк{suffix ? ` · ${suffix}` : ''}</span>
      {suffix ? null : <span className="brand-tag">учебный</span>}
    </Link>
  );
}
