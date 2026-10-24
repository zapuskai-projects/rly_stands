import type { Pool } from 'pg';
import { findDecision } from '../../antifraud/decisions.repository';
import { findClientById } from '../../clients/clients.repository';
import { listOfficeOperations, type OfficeOperationFilter } from '../../office/operations.repository';
import { findOperationOfAnyClient, loadStatusHistories, type OperationType } from '../../payments/operations.repository';
import type { OperationStatus } from '../../payments/status';
import type { ReleaseSource } from '../../release/release-source';
import { findReviewItem } from '../../review/review.repository';
import { notFound } from '../../shared/errors';
import { operationDto, reviewItemDto } from '../dto';
import { antifraudResultDto, officeOperationRowDto } from '../dto-office';
import type { Handler } from '../router';

const DEFAULT_PAGE_SIZE = 20;

function toFilter(query: Record<string, unknown>): OfficeOperationFilter {
  const filter: OfficeOperationFilter = {};
  if (query.number) filter.number = String(query.number).trim();
  if (query.clientNumber) filter.clientNumber = String(query.clientNumber).trim();
  if (query.status) filter.status = query.status as OperationStatus;
  if (query.type) filter.type = query.type as OperationType;
  return filter;
}

export function officeOperationHandlers(pool: Pool, releases: ReleaseSource): Record<string, Handler> {
  return {
    listOfficeOperations: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const { rows, total } = await listOfficeOperations(pool, toFilter(ctx.query), limit, offset);
      return { status: 200, body: { items: rows.map(officeOperationRowDto), total, limit, offset } };
    },
    getOfficeOperation: async (ctx) => {
      const operationId = String(ctx.params.operationId);
      const operation = await findOperationOfAnyClient(pool, operationId);
      if (!operation) throw notFound('OPERATION_NOT_FOUND', 'Операция не найдена');
      const client = await findClientById(pool, operation.clientId);
      const histories = await loadStatusHistories(pool, [operation.id]);
      const decision = await findDecision(pool, operation.id);
      const review = await findReviewItem(pool, operation.id);
      return {
        status: 200,
        operationId,
        body: {
          operation: operationDto(operation, histories.get(operation.id) ?? [], await releases.atLeast('1.1')),
          client: { number: client?.number ?? '', fullName: client?.fullName ?? '' },
          antifraud: decision ? antifraudResultDto(decision) : null,
          review: review ? reviewItemDto(review) : null,
        },
      };
    },
  };
}
