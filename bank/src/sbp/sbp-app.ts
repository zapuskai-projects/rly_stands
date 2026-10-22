import { randomInt, randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { loadSbpMode } from '../scenario/scenario.repository';
import { logger } from '../shared/logger';

const REJECT_REASON = 'RECIPIENT_BANK_DECLINED';
const HANG_LIMIT_MS = 120_000;

const requestSchema = z.object({
  operationId: z.string().uuid(),
  operationNumber: z.string(),
  amount: z.number().int().positive(),
  currency: z.literal('RUB'),
  recipientPhone: z.string().regex(/^\+79[0-9]{9}$/),
  recipientBankCode: z.string(),
  senderBank: z.string(),
  requestId: z.string(),
});

export interface SbpAppOptions {
  pool: Pool;
  minDelayMs: number;
  maxDelayMs: number;
}

export function pickDelay(minMs: number, maxMs: number, random: (low: number, high: number) => number = randomInt): number {
  return maxMs <= minMs ? minMs : random(minMs, maxMs + 1);
}

function sleep(ms: number, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    res.on('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function handleTransfer(options: SbpAppOptions, req: Request, res: Response): Promise<void> {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'INVALID', reason: 'Неверный формат запроса' });
    return;
  }
  const transfer = parsed.data;
  const requestId = String(req.headers['x-request-id'] ?? transfer.requestId);
  const mode = await loadSbpMode(options.pool);
  logger.info('sbp transfer received', { operationId: transfer.operationId, requestId, mode });

  if (mode === 'DOWN') {
    res.status(503).json({ status: 'UNAVAILABLE', reason: 'Система быстрых платежей недоступна' });
    return;
  }
  if (mode === 'TIMEOUT') {
    await sleep(HANG_LIMIT_MS, res);
    if (!res.headersSent && !res.destroyed) res.status(504).json({ status: 'UNAVAILABLE', reason: 'Время ожидания истекло' });
    return;
  }
  const completed = await sleep(pickDelay(options.minDelayMs, options.maxDelayMs), res);
  if (!completed) return;
  if (mode === 'REJECT') {
    logger.info('sbp transfer rejected', { operationId: transfer.operationId, requestId });
    res.json({ status: 'REJECTED', reason: REJECT_REASON });
    return;
  }
  logger.info('sbp transfer accepted', { operationId: transfer.operationId, requestId });
  res.json({ status: 'ACCEPTED', reference: `SBP-${randomUUID().slice(0, 8).toUpperCase()}` });
}

const lookupQuery = z.object({ phone: z.string().regex(/^\+79[0-9]{9}$/), bankCode: z.string().regex(/^[A-Z0-9_]{2,20}$/) });

async function handleLookup(options: SbpAppOptions, req: Request, res: Response): Promise<void> {
  const parsed = lookupQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ found: false, displayName: null });
    return;
  }
  const result = await options.pool.query<{ display_name: string }>(
    'SELECT display_name FROM sbp_directory WHERE phone = $1 AND bank_code = $2',
    [parsed.data.phone, parsed.data.bankCode],
  );
  const name = result.rows[0]?.display_name ?? null;
  res.json({ found: name !== null, displayName: name });
}

export function buildSbpApp(options: SbpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => {
    res.json({ status: 'UP' });
  });
  app.get('/sbp/v1/lookup', (req, res, next) => {
    handleLookup(options, req, res).catch(next);
  });
  app.post('/sbp/v1/transfers', (req, res, next) => {
    handleTransfer(options, req, res).catch(next);
  });
  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    logger.error('sbp error', { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).json({ status: 'UNAVAILABLE', reason: 'Внутренняя ошибка' });
  });
  return app;
}
