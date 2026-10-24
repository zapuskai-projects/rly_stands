import type { Pool } from 'pg';
import { mulDivRoundHalfUp, toApiAmount } from '../../accounts/money';
import { findDecision } from '../../antifraud/decisions.repository';
import { loadThresholds } from '../../antifraud/settings.repository';
import type { BankClock } from '../../clock/bank-clock';
import { toMoscowIso } from '../../clock/moscow';
import { findClientById } from '../../clients/clients.repository';
import { findPrimaryAccount } from '../../accounts/accounts.repository';
import { listClientRecentOperations } from '../../office/operations.repository';
import { findOperationOfAnyClient, loadUsualAmounts } from '../../payments/operations.repository';
import { approveReview, rejectReview } from '../../review/review.service';
import { findReviewItem, listReviewItems, type ReviewState } from '../../review/review.repository';
import { notFound } from '../../shared/errors';
import { getTariff } from '../../tariffs/tariffs.repository';
import { hiddenOperationTypes } from '../../release/release';
import type { ReleaseSource } from '../../release/release-source';
import { reviewItemDto } from '../dto';
import { officeOperationRowDto } from '../dto-office';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
  releases: ReleaseSource;
}

interface CommentBody {
  comment?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const RECENT_OPERATIONS = 6;
const operatorOf = (ctx: HandlerContext): string => (ctx.operator as { login: string }).login;
const operationIdOf = (ctx: HandlerContext): string => String(ctx.params.operationId);

async function reviewDetails(pool: Pool, releases: ReleaseSource, operationId: string) {
  const item = await findReviewItem(pool, operationId);
  const operation = await findOperationOfAnyClient(pool, operationId);
  if (!item || !operation) throw notFound('REVIEW_NOT_FOUND', 'Проверки по этой операции нет');
  const client = await findClientById(pool, operation.clientId);
  if (!client) throw notFound('CLIENT_NOT_FOUND', 'Клиент не найден');
  const usual = await loadUsualAmounts(pool, client.id);
  const stored = await findDecision(pool, operationId);
  const thresholds = stored ? { review: stored.reviewThreshold, reject: stored.rejectThreshold } : await loadThresholds(pool);
  const primary = await findPrimaryAccount(pool, client.id);
  const tariff = await getTariff(pool, client.tariffCode);
  const recent = (await listClientRecentOperations(pool, client.id, RECENT_OPERATIONS + 1, hiddenOperationTypes(await releases.current()))).filter((row) => row.id !== operationId);
  return {
    review: reviewItemDto(item),
    client: {
      number: client.number,
      fullName: client.fullName,
      kind: client.kind,
      resident: client.resident,
      customerSince: toMoscowIso(client.createdAt),
      tariffName: tariff.name,
      usualAmount: usual.count > 0 ? toApiAmount(mulDivRoundHalfUp(usual.total, 1n, BigInt(usual.count))) : null,
      accountNumber: primary?.number ?? '',
    },
    thresholds,
    recentOperations: recent.slice(0, RECENT_OPERATIONS).map(officeOperationRowDto),
  };
}

export function officeHandlers({ pool, clock, releases }: Deps): Record<string, Handler> {
  return {
    listOfficeReviews: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const state = (ctx.query.state as ReviewState | undefined) ?? null;
      const { rows, total } = await listReviewItems(pool, state, limit, offset);
      return { status: 200, body: { items: rows.map(reviewItemDto), total, limit, offset } };
    },
    getOfficeReview: async (ctx) => ({ status: 200, body: await reviewDetails(pool, releases, operationIdOf(ctx)), operationId: operationIdOf(ctx) }),
    approveReview: async (ctx) => {
      const comment = (ctx.body as CommentBody | undefined)?.comment?.trim() || null;
      const item = await approveReview({ pool, clock }, operationIdOf(ctx), operatorOf(ctx), comment, ctx.requestId);
      return { status: 200, body: reviewItemDto(item), operationId: item.operationId };
    },
    rejectReview: async (ctx) => {
      const comment = (ctx.body as { comment: string }).comment.trim();
      const item = await rejectReview({ pool, clock }, operationIdOf(ctx), operatorOf(ctx), comment, ctx.requestId);
      return { status: 200, body: reviewItemDto(item), operationId: item.operationId };
    },
  };
}
