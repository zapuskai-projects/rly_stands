const CONFLICT_CODES = new Set(['40P01', '40001', '55P03']);
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 250;

export function isDatabaseConflict(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CONFLICT_CODES.has(code);
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function retryOnConflict<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isDatabaseConflict(error)) throw error;
      options.onRetry?.(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
