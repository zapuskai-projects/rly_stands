import { initials } from '../lib/format';
import { statusTone } from '../lib/status';
import type { OperationStatus } from '../lib/types';

export function Avatar({ name, tone = 'neutral' }: { name: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }) {
  return (
    <span className={`avatar${tone === 'neutral' ? '' : ` avatar-${tone}`}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function avatarToneFor(status: OperationStatus): 'neutral' | 'warn' | 'bad' | 'info' {
  const tone = statusTone(status);
  if (tone === 'warn') return 'warn';
  if (tone === 'bad') return 'bad';
  if (tone === 'info') return 'info';
  return 'neutral';
}
