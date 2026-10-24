import { clientApi } from './api';
import { useAsync } from './hooks';

const ORDER = ['1.0', '1.1', '1.2'];
const SHARED_MS = 3000;

export function bankVersionLabel(release: string | null | undefined): string | null {
  return release && /^[0-9]+\.[0-9]+$/.test(release) ? `ЗапускБанк ${release}` : null;
}

export type GateDecision = 'wait' | 'show' | 'hide';

export function gateDecision(loading: boolean, release: string | null | undefined, required: string): GateDecision {
  if (loading) return 'wait';
  return releaseAtLeast(release, required) ? 'show' : 'hide';
}

export function releaseAtLeast(current: string | null | undefined, required: string): boolean {
  const index = ORDER.indexOf(current ?? '');
  return index >= 0 && index >= ORDER.indexOf(required);
}

let shared: { at: number; request: Promise<string | null> } | null = null;

export function fetchBankRelease(): Promise<string | null> {
  if (shared && Date.now() - shared.at < SHARED_MS) return shared.request;
  const request = clientApi
    .anonymous<{ release?: string }>('GET', '/health')
    .then((health) => health.release ?? null)
    .catch(() => null);
  shared = { at: Date.now(), request };
  return request;
}

export async function fetchBankVersionLabel(): Promise<string | null> {
  return bankVersionLabel(await fetchBankRelease());
}

export function useBankRelease(): string | null {
  return useAsync(fetchBankRelease, []).data;
}

export function useBankReleaseState(): { release: string | null; loading: boolean } {
  const state = useAsync(fetchBankRelease, []);
  return { release: state.data, loading: state.loading };
}
