import { timingSafeEqual } from 'node:crypto';
import express, { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import type { RequestJournal } from '../api/request-context';
import type { RecipientNameLookup } from '../sbp/gateway';
import { notFound } from '../shared/errors';
import { runReview, runSetTariff, runTransfer } from './actions';
import { createCheckClient } from './check-client';
import { findLedgerFact, findOperationFact, listInconsistentAccounts, listOperationFacts, listRequestFacts } from './facts';
import { resetBank } from './reset';
import { applyScenario } from './scenario';
import { kitSchemas, parseKit } from './schemas';
import { findTariffs, tariffFact } from './tariffs';

export interface KitDeps {
  pool: Pool;
  clock: BankClock;
  secret: string | null;
  lookupRecipient: RecipientNameLookup;
  journal: Pick<RequestJournal, 'settle'>;
}

const SECRET_HEADER = 'x-kit-secret';

function sameSecret(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function notFoundError(req: Request) {
  return notFound('NOT_FOUND', `Метод ${req.method} ${req.originalUrl.split('?')[0]} не найден`);
}

function gate(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!sameSecret(req.header(SECRET_HEADER), secret)) {
      next(notFoundError(req));
      return;
    }
    res.locals.kitAuthorized = true;
    next();
  };
}

function normalizePhoneQuery(query: Request['query']): Record<string, unknown> {
  const phone = typeof query.phone === 'string' ? query.phone.trim() : undefined;
  return { ...query, ...(phone === undefined ? {} : { phone: phone.startsWith('+') ? phone : `+${phone}` }) };
}

export function mountKit(app: Express, deps: KitDeps): void {
  if (!deps.secret) return;
  const router = Router();
  router.use(gate(deps.secret));
  router.use(express.json({ limit: '256kb' }));

  router.post('/scenario', async (req, res) => {
    await applyScenario(deps, parseKit(kitSchemas.scenario, req.body));
    res.json({ applied: true });
  });

  router.post('/reset', async (_req, res) => {
    await resetBank(deps);
    res.json({ reset: true });
  });

  router.post('/actions/transfer', async (req, res) => {
    const input = parseKit(kitSchemas.transferAction, req.body);
    res.locals.attemptLabel = input.label;
    res.locals.idempotencyKey = input.idempotencyKey;
    const result = await runTransfer(deps, input, String(res.locals.requestId));
    res.locals.clientId = result.clientId;
    res.locals.operationId = result.operationId;
    res.locals.replayed = result.replayed;
    if (result.rejectCode !== null) res.locals.errorCode = result.rejectCode;
    res.json({ operationId: result.operationId, number: result.number, status: result.status });
  });

  router.post('/actions/check-client', async (req, res) => {
    res.json(await createCheckClient(deps, parseKit(kitSchemas.checkClientAction, req.body)));
  });

  router.post('/actions/set-tariff', async (req, res) => {
    res.json(await runSetTariff(deps, parseKit(kitSchemas.tariffPatch, req.body)));
  });

  router.post('/actions/review', async (req, res) => {
    const input = parseKit(kitSchemas.reviewAction, req.body);
    res.locals.operationId = input.operationId;
    res.json(await runReview(deps, input, String(res.locals.requestId)));
  });

  router.get('/facts/operations', async (req, res) => {
    const filter = parseKit(kitSchemas.operationsQuery, normalizePhoneQuery(req.query));
    if (filter.label !== undefined) await deps.journal.settle(filter.label);
    res.json(await listOperationFacts(deps.pool, filter, deps.clock.now()));
  });

  router.get('/facts/operations/:idOrNumber', async (req, res) => {
    const fact = await findOperationFact(deps.pool, String(req.params.idOrNumber), deps.clock.now());
    if (!fact) throw notFound('OPERATION_NOT_FOUND', 'Операция не найдена');
    res.json(fact);
  });

  router.get('/facts/ledger', async (req, res) => {
    const { account } = parseKit(kitSchemas.ledgerQuery, req.query);
    if (account === undefined) {
      res.json({ inconsistent: await listInconsistentAccounts(deps.pool) });
      return;
    }
    const fact = await findLedgerFact(deps.pool, account);
    if (!fact) throw notFound('ACCOUNT_NOT_FOUND', 'Счёт не найден');
    res.json(fact);
  });

  router.get('/facts/requests', async (req, res) => {
    const { label } = parseKit(kitSchemas.requestsQuery, req.query);
    await deps.journal.settle(label);
    res.json(await listRequestFacts(deps.pool, label));
  });

  router.get('/facts/tariffs/:code', async (req, res) => {
    const tariff = (await findTariffs(deps.pool)).get(String(req.params.code));
    if (!tariff) throw notFound('TARIFF_NOT_FOUND', 'Тариф не найден');
    res.json(tariffFact(tariff));
  });

  router.use((req, _res, next) => {
    next(notFoundError(req));
  });
  app.use('/_kit', router);
}
