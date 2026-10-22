import type { NextFunction, Request, Response } from 'express';
import { BankError } from '../shared/errors';
import { logger } from '../shared/logger';

interface ErrorBody {
  code: string;
  message: string;
  requestId: string;
  details?: { field: string; message: string }[];
}

function bodyParserError(error: unknown): { status: number; code: string; message: string } | null {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') return { status: 400, code: 'MALFORMED_JSON', message: 'Тело запроса не является корректным JSON' };
  if (type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком большое' };
  return null;
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const requestId = String(res.locals.requestId ?? 'unknown');
  let status = 500;
  const body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка банка', requestId };
  const parserError = bodyParserError(error);
  if (error instanceof BankError) {
    status = error.status;
    body.code = error.code;
    body.message = error.message;
    if (error.details) body.details = error.details;
  } else if (parserError) {
    status = parserError.status;
    body.code = parserError.code;
    body.message = parserError.message;
  } else {
    logger.error('unhandled error', {
      requestId,
      path: req.originalUrl,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
  res.locals.errorCode = body.code;
  res.status(status).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    code: 'NOT_FOUND',
    message: `Метод ${req.method} ${req.path} не найден`,
    requestId: String(res.locals.requestId ?? 'unknown'),
  };
  res.locals.errorCode = body.code;
  res.status(404).json(body);
}
