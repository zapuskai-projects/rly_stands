import { ZodError } from 'zod';

export interface ErrorDetail {
  field: string;
  message: string;
}

export class BankError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'BankError';
  }
}

export const badRequest = (code: string, message: string, details?: ErrorDetail[]) =>
  new BankError(400, code, message, details);

export const unauthorized = (code: string, message: string) => new BankError(401, code, message);

export const forbidden = (code: string, message: string) => new BankError(403, code, message);

export const notFound = (code: string, message: string) => new BankError(404, code, message);

export const unprocessable = (code: string, message: string) => new BankError(422, code, message);

export const conflict = (code: string, message: string) => new BankError(409, code, message);

export function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
