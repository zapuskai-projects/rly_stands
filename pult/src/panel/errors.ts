export class PanelError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export function requireObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new PanelError(400, 'INVALID_BODY', 'Недопустимые поля запроса');
  return value as Record<string, unknown>;
}

export function stringField(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new PanelError(400, 'INVALID_BODY', 'Недопустимое значение');
  return value;
}
