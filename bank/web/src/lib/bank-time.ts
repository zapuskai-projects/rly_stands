const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export function moscowIso(epochMs: number): string {
  const shifted = new Date(epochMs + MOSCOW_OFFSET_MS);
  const iso = shifted.toISOString();
  return `${iso.slice(0, 23)}+03:00`;
}

export function moscowHour(epochMs: number): number {
  return new Date(epochMs + MOSCOW_OFFSET_MS).getUTCHours();
}

interface Anchor {
  bankMs: number;
  localMs: number;
}

let anchor: Anchor | null = null;

export function noteBankTime(headerValue: string | null, localMs: number = Date.now()): void {
  if (!headerValue) return;
  const bankMs = Date.parse(headerValue);
  if (Number.isFinite(bankMs)) anchor = { bankMs, localMs };
}

export function bankNowMs(localMs: number = Date.now()): number {
  return anchor ? anchor.bankMs + (localMs - anchor.localMs) : localMs;
}

export function bankNowIso(localMs?: number): string {
  return moscowIso(bankNowMs(localMs));
}

export function bankDateKey(localMs?: number): string {
  return bankNowIso(localMs).slice(0, 10);
}

export function resetBankTime(): void {
  anchor = null;
}
