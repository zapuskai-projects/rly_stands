import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { toMoscowIso } from '../clock/moscow';
import { logger } from '../shared/logger';
import { PendingWrites } from './journal-pending';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
const ATTEMPT_LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const JOURNALED_PREFIXES = ['/api/v1', '/partner/v1'];
const KIT_ACTIONS_PREFIX = '/_kit/actions/';

function isJournaled(url: string): boolean {
  return JOURNALED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

export async function activeScenarioLabel(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ label: string | null }>('SELECT label FROM scenario WHERE id = 1');
  const label = result.rows[0]?.label ?? null;
  return label && ATTEMPT_LABEL_PATTERN.test(label) ? label : null;
}

export function requestContext(clock: BankClock, pool: Pool): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = headerValue(req, 'x-request-id');
    const requestId = provided && REQUEST_ID_PATTERN.test(provided) ? provided : randomUUID();
    const label = headerValue(req, 'x-attempt-label');
    const headerLabel = label && ATTEMPT_LABEL_PATTERN.test(label) ? label : null;
    res.locals.requestId = requestId;
    res.locals.attemptLabel = headerLabel;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Bank-Time', toMoscowIso(clock.now()));
    if (headerLabel || !isJournaled(req.originalUrl)) {
      next();
      return;
    }
    activeScenarioLabel(pool).then(
      (active) => {
        res.locals.attemptLabel = active;
        next();
      },
      () => next(),
    );
  };
}

export interface RequestJournal {
  middleware: RequestHandler;
  settle(label: string, timeoutMs?: number): Promise<void>;
}

const SETTLE_TIMEOUT_MS = 1000;

export function recordOutcome(res: Response, result: { body?: unknown; headers?: Record<string, string> }): void {
  res.locals.replayed = result.headers?.['Idempotent-Replayed'] === 'true';
  const body = result.body as { status?: string; rejection?: { code?: string } } | null | undefined;
  if (body?.status === 'REJECTED' && typeof body.rejection?.code === 'string') res.locals.errorCode = body.rejection.code;
}

export function createRequestJournal(pool: Pool, clock: BankClock): RequestJournal {
  const pending = new PendingWrites();
  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const isKitAction = req.originalUrl.startsWith(KIT_ACTIONS_PREFIX);
    if (!isJournaled(req.originalUrl) && !isKitAction) {
      next();
      return;
    }
    const startedAt = Date.now();
    const requestedAt = clock.now();
    res.on('finish', () => {
      if (isKitAction && res.locals.kitAuthorized !== true) return;
      const [path = '', query = ''] = req.originalUrl.split('?');
      const key = headerValue(req, 'idempotency-key') ?? (res.locals.idempotencyKey as string | undefined) ?? null;
      const write = pool
        .query(
          `INSERT INTO request_log (request_id, method, path, query, status, idempotency_key, attempt_label, client_id, operation_id, duration_ms, requested_at, error_code, replayed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            res.locals.requestId,
            req.method,
            path,
            query || null,
            res.statusCode,
            key,
            res.locals.attemptLabel ?? null,
            res.locals.clientId ?? null,
            res.locals.operationId ?? null,
            Date.now() - startedAt,
            requestedAt,
            res.locals.errorCode ?? null,
            res.locals.replayed === true,
          ],
        )
        .catch((error: unknown) => {
          logger.warn('request journal write failed', {
            requestId: res.locals.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      pending.track((res.locals.attemptLabel as string | null | undefined) ?? null, write);
      logger.info('request', {
        requestId: res.locals.requestId,
        operationId: res.locals.operationId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        ...(res.locals.errorCode ? { errorCode: res.locals.errorCode } : {}),
      });
    });
    next();
  };
  return { middleware, settle: (label, timeoutMs = SETTLE_TIMEOUT_MS) => pending.settle(label, timeoutMs) };
}
