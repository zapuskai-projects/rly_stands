import type { Express, Request, Response } from 'express';
import { authenticate, type AuthDeps } from '../auth/auth.service';
import { authenticateOperator } from '../operators/operators.service';
import type { Operator } from '../operators/operators.repository';
import type { ActiveSession } from '../auth/auth.repository';
import { extractBearerToken } from '../auth/codes';
import { BankError, type ErrorDetail } from '../shared/errors';
import { logger } from '../shared/logger';
import { ROOT_FIELD, type Contract, type OperationSpec } from './contract';
import { requireRelease, type ReleaseSource } from '../release/release-source';
import { recordOutcome } from './request-context';

export interface HandlerContext {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  session: ActiveSession | null;
  operator: (Operator & { sessionId: string }) | null;
  requestId: string;
  attemptLabel: string | null;
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  operationId?: string;
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

function readRawParam(req: Request, location: 'path' | 'query' | 'header', name: string): unknown {
  if (location === 'path') return req.params[name];
  if (location === 'query') return req.query[name];
  return req.headers[name.toLowerCase()];
}

function qualify(prefix: string, field: string): string {
  return field === ROOT_FIELD ? prefix : `${prefix}.${field}`;
}

function collectParams(req: Request, operation: OperationSpec) {
  const buckets = { path: {} as Record<string, unknown>, query: {} as Record<string, unknown>, header: {} as Record<string, unknown> };
  const issues: ErrorDetail[] = [];
  for (const param of operation.params) {
    const raw = readRawParam(req, param.location, param.name);
    if (raw === undefined || raw === '') {
      if (param.required) issues.push({ field: `${param.location}.${param.name}`, message: 'Обязательный параметр не передан' });
      continue;
    }
    const value = param.coerce === 'number' && typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    const result = param.validator.validate(value);
    if (result.ok) buckets[param.location][param.name] = result.value;
    else issues.push(...result.issues.map((issue) => ({ field: `${param.location}.${param.name}`, message: issue.message })));
  }
  return { buckets, issues };
}

function collectBody(req: Request, operation: OperationSpec): { value: unknown; issues: ErrorDetail[] } {
  if (!operation.body) return { value: undefined, issues: [] };
  if (req.body === undefined && !operation.body.required) return { value: undefined, issues: [] };
  if (req.body === undefined) {
    return { value: undefined, issues: [{ field: 'body', message: 'Тело запроса обязательно, Content-Type: application/json' }] };
  }
  const result = operation.body.validator.validate(req.body);
  if (result.ok) return { value: result.value, issues: [] };
  return { value: undefined, issues: result.issues.map((issue) => ({ field: qualify('body', issue.field), message: issue.message })) };
}

function contractViolation(operation: OperationSpec, requestId: string, issues: unknown): never {
  logger.error('contract violation', { operationId: operation.operationId, requestId, issues });
  throw new BankError(500, 'CONTRACT_VIOLATION', 'Ответ банка не соответствует контракту API');
}

function respond(res: Response, operation: OperationSpec, requestId: string, result: HandlerResult): void {
  const validator = operation.responses.get(result.status);
  if (validator === undefined) contractViolation(operation, requestId, `статус ${result.status} не описан в контракте`);
  if (validator === null && result.body !== undefined) contractViolation(operation, requestId, 'тело в ответе без содержимого');
  if (validator) {
    const check = validator.validate(result.body);
    if (!check.ok) contractViolation(operation, requestId, check.issues);
  }
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  res.status(result.status);
  if (result.body === undefined) res.end();
  else res.json(result.body);
}

async function execute(req: Request, res: Response, operation: OperationSpec, handler: Handler, auth: AuthDeps): Promise<void> {
  const requestId = res.locals.requestId as string;
  const token = extractBearerToken(req.headers.authorization);
  const session = operation.auth === 'CLIENT' ? await authenticate(auth, token) : null;
  if (session) res.locals.clientId = session.clientId;
  const operatorSession = operation.auth === 'OPERATOR' ? await authenticateOperator(auth.pool, token) : null;
  const { buckets, issues: paramIssues } = collectParams(req, operation);
  const body = collectBody(req, operation);
  const issues = [...paramIssues, ...body.issues];
  if (issues.length > 0) throw new BankError(400, 'VALIDATION_ERROR', 'Запрос не прошёл проверку формата', issues);
  const result = await handler({
    params: buckets.path,
    query: buckets.query,
    headers: buckets.header,
    body: body.value,
    session,
    operator: operatorSession ? { ...operatorSession.operator, sessionId: operatorSession.sessionId } : null,
    requestId,
    attemptLabel: (res.locals.attemptLabel as string | null) ?? null,
  });
  if (result.operationId) res.locals.operationId = result.operationId;
  recordOutcome(res, result);
  respond(res, operation, requestId, result);
}

export function registerOperations(app: Express, contract: Contract, handlers: Record<string, Handler>, auth: AuthDeps, releases: ReleaseSource): void {
  const declared = new Set(contract.operations.map((operation) => operation.operationId));
  const missing = [...declared].filter((id) => !handlers[id]);
  const extra = Object.keys(handlers).filter((id) => !declared.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Реализация расходится с контрактом. Нет обработчиков: ${missing.join(', ') || '—'}. Лишние обработчики: ${extra.join(', ') || '—'}`);
  }
  for (const operation of contract.operations) {
    const handler = handlers[operation.operationId] as Handler;
    const available = operation.release ? [requireRelease(releases, operation.release)] : [];
    app[operation.method](operation.expressPath, ...available, async (req: Request, res: Response) => {
      try {
        await execute(req, res, operation, handler, auth);
      } catch (error) {
        if (error instanceof BankError && !operation.responses.has(error.status)) {
          logger.error('undeclared error status', { operationId: operation.operationId, status: error.status, code: error.code });
        }
        throw error;
      }
    });
  }
}
