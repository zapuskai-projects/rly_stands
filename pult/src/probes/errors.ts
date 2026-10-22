export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

export function errorCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = errorCode(error);
  return code ? `${error.message} (${code})` : error.message;
}
