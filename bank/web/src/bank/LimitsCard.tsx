import { formatWholeRubles } from '../lib/format';
import type { LimitUsage, Profile } from '../lib/types';

function Line({ title, usage, testId }: { title: string; usage: LimitUsage; testId: string }) {
  const percent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <div className="limit-line" data-testid={testId}>
      <span>{title}</span>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={title}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="limit-figures">
        {formatWholeRubles(usage.used)} из {formatWholeRubles(usage.limit)}
      </span>
    </div>
  );
}

export function LimitsCard({ profile }: { profile: Profile }) {
  return (
    <section aria-label="Лимиты и тариф" className="card limit-card" data-testid="limits-card">
      <h2 className="section-title">Лимиты и тариф</h2>
      <Line title="Переводы по телефону сегодня" usage={profile.limits.dailyPhoneTransfer} testId="limit-daily" />
      <Line title="Без комиссии в этом месяце" usage={profile.limits.monthlyFreeVolume} testId="limit-monthly" />
      <div className="limit-tariff">
        <span className="muted">Тариф</span>
        <span style={{ fontWeight: 600 }} data-testid="tariff-name">
          {profile.tariff.name}
        </span>
      </div>
    </section>
  );
}
