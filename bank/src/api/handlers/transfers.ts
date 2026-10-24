import type { Pool } from 'pg';
import type { BankClock } from '../../clock/bank-clock';
import { parseMoscowDate, moscowNextDayStart } from '../../clock/moscow';
import { fromApiAmount } from '../../accounts/money';
import {
  findClientOperation,
  listClientOperations,
  loadStatusHistories,
  type OperationFilter,
  type OperationType,
} from '../../payments/operations.repository';
import type { OperationStatus } from '../../payments/status';
import type { TransferCommand } from '../../payments/transfer-command';
import { createTransfer } from '../../payments/transfer.service';
import { hiddenOperationTypes } from '../../release/release';
import type { ReleaseSource } from '../../release/release-source';
import type { RecipientNameLookup } from '../../sbp/gateway';
import { BANK } from '../../shared/bank-identity';
import { badRequest, notFound } from '../../shared/errors';
import { operationDto } from '../dto';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient: RecipientNameLookup;
  releases: ReleaseSource;
}

interface TransferBody {
  type: 'OWN_TRANSFER' | 'PHONE_TRANSFER';
  fromAccount: string;
  toAccount?: string;
  recipientPhone?: string;
  recipientBankCode?: string;
  amount: number;
  comment?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const clientIdOf = (ctx: HandlerContext): string => (ctx.session as { clientId: string }).clientId;

function toCommand(body: TransferBody): TransferCommand {
  const comment = body.comment?.trim() ? body.comment.trim() : null;
  if (body.type === 'OWN_TRANSFER') {
    return {
      type: 'OWN_TRANSFER',
      fromAccount: body.fromAccount,
      toAccount: body.toAccount as string,
      amount: fromApiAmount(body.amount),
      comment,
    };
  }
  return {
    type: 'PHONE_TRANSFER',
    fromAccount: body.fromAccount,
    recipientPhone: body.recipientPhone as string,
    recipientBankCode: body.recipientBankCode ?? BANK.code,
    amount: fromApiAmount(body.amount),
    comment,
  };
}

function toFilter(query: Record<string, unknown>): OperationFilter {
  const filter: OperationFilter = {};
  if (query.status) filter.status = query.status as OperationStatus;
  if (query.type) filter.type = query.type as OperationType;
  if (query.number) filter.number = String(query.number);
  const from = query.from ? parseMoscowDate(String(query.from)) : null;
  const to = query.to ? parseMoscowDate(String(query.to)) : null;
  if (from && to && from > to) throw badRequest('INVALID_PERIOD', 'Начало периода позже его конца');
  if (from) filter.createdFrom = from;
  if (to) filter.createdBefore = moscowNextDayStart(to);
  return filter;
}

export async function loadOperationDto(pool: Pool, releases: ReleaseSource, clientId: string, operationId: string) {
  const release = await releases.current();
  const operation = await findClientOperation(pool, clientId, operationId, hiddenOperationTypes(release));
  if (!operation) throw notFound('OPERATION_NOT_FOUND', 'Операция не найдена');
  const histories = await loadStatusHistories(pool, [operation.id]);
  return operationDto(operation, histories.get(operation.id) ?? [], release);
}

export function transferHandlers({ pool, clock, lookupRecipient, releases }: Deps): Record<string, Handler> {
  return {
    createTransfer: async (ctx) => {
      const clientId = clientIdOf(ctx);
      const result = await createTransfer(
        { pool, clock, lookupRecipient },
        {
          clientId,
          idempotencyKey: String(ctx.headers['Idempotency-Key']),
          command: toCommand(ctx.body as TransferBody),
          requestId: ctx.requestId,
          attemptLabel: ctx.attemptLabel,
        },
      );
      const body = await loadOperationDto(pool, releases, clientId, result.operationId);
      return {
        status: result.replayed ? 200 : 201,
        body,
        headers: result.replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        operationId: result.operationId,
      };
    },
    listOperations: async (ctx) => {
      const clientId = clientIdOf(ctx);
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const release = await releases.current();
      const filter = { ...toFilter(ctx.query), excludeTypes: hiddenOperationTypes(release) };
      const { rows, total } = await listClientOperations(pool, clientId, filter, limit, offset);
      const histories = await loadStatusHistories(pool, rows.map((row) => row.id));
      const items = rows.map((row) => operationDto(row, histories.get(row.id) ?? [], release));
      return { status: 200, body: { items, total, limit, offset } };
    },
    getOperation: async (ctx) => {
      const body = await loadOperationDto(pool, releases, clientIdOf(ctx), String(ctx.params.operationId));
      return { status: 200, body, operationId: body.id };
    },
  };
}
