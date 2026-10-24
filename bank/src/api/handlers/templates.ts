import type { Pool } from 'pg';
import { fromApiAmount } from '../../accounts/money';
import type { BankClock } from '../../clock/bank-clock';
import { findClientOperation, loadStatusHistories } from '../../payments/operations.repository';
import type { ReleaseSource } from '../../release/release-source';
import type { RecipientNameLookup } from '../../sbp/gateway';
import { notFound } from '../../shared/errors';
import type { TemplateKind } from '../../templates/template-rules';
import { listClientTemplates } from '../../templates/templates.repository';
import {
  changeTemplate,
  createTemplate,
  removeTemplate,
  transferByTemplate,
  type CreateTemplateInput,
  type TemplatePatchInput,
} from '../../templates/templates.service';
import { operationDto } from '../dto';
import { templateDto } from '../dto-templates';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient: RecipientNameLookup;
  releases: ReleaseSource;
}

interface CreateBody {
  name: string;
  fromOperationId?: string;
  kind?: TemplateKind;
  fromAccount?: string;
  toAccount?: string;
  recipientPhone?: string;
  recipientBankCode?: string;
  amount?: number;
  comment?: string;
}

interface UpdateBody {
  name?: string;
  fromAccount?: string;
  amount?: number | null;
  comment?: string | null;
}

interface TransferBody {
  amount?: number;
  comment?: string;
}

const clientIdOf = (ctx: HandlerContext): string => (ctx.session as { clientId: string }).clientId;
const templateIdOf = (ctx: HandlerContext): string => String(ctx.params.templateId);

function toCreateInput(body: CreateBody): CreateTemplateInput {
  return {
    name: body.name,
    fromOperationId: body.fromOperationId,
    kind: body.kind,
    fromAccount: body.fromAccount,
    toAccount: body.toAccount,
    recipientPhone: body.recipientPhone,
    recipientBankCode: body.recipientBankCode,
    amount: body.amount === undefined ? undefined : fromApiAmount(body.amount),
    comment: body.comment === undefined ? undefined : body.comment.trim() ? body.comment.trim() : null,
  };
}

function toPatch(body: UpdateBody): TemplatePatchInput {
  return {
    name: body.name,
    fromAccount: body.fromAccount,
    amount: body.amount === undefined ? undefined : body.amount === null ? null : fromApiAmount(body.amount),
    comment: body.comment === undefined ? undefined : body.comment?.trim() ? body.comment.trim() : null,
  };
}

export function templateHandlers({ pool, clock, lookupRecipient, releases }: Deps): Record<string, Handler> {
  const deps = { pool, clock, lookupRecipient };
  return {
    listTemplates: async (ctx) => ({ status: 200, body: { items: (await listClientTemplates(pool, clientIdOf(ctx))).map(templateDto) } }),
    createTemplate: async (ctx) => {
      const created = await createTemplate(deps, clientIdOf(ctx), toCreateInput(ctx.body as CreateBody));
      return { status: 201, body: templateDto(created) };
    },
    updateTemplate: async (ctx) => {
      const patch = toPatch(ctx.body as UpdateBody);
      const updated = await changeTemplate(deps, clientIdOf(ctx), templateIdOf(ctx), patch);
      return { status: 200, body: templateDto(updated) };
    },
    deleteTemplate: async (ctx) => {
      await removeTemplate(deps, clientIdOf(ctx), templateIdOf(ctx));
      return { status: 204 };
    },
    createTemplateTransfer: async (ctx) => {
      const clientId = clientIdOf(ctx);
      const body = (ctx.body ?? {}) as TransferBody;
      const result = await transferByTemplate(deps, {
        clientId,
        templateId: templateIdOf(ctx),
        idempotencyKey: String(ctx.headers['Idempotency-Key']),
        amount: body.amount === undefined ? undefined : fromApiAmount(body.amount),
        comment: body.comment?.trim() ? body.comment.trim() : undefined,
        requestId: ctx.requestId,
        attemptLabel: ctx.attemptLabel,
      });
      const operation = await findClientOperation(pool, clientId, result.operationId);
      if (!operation) throw notFound('OPERATION_NOT_FOUND', 'Операция не найдена');
      const histories = await loadStatusHistories(pool, [operation.id]);
      return {
        status: result.replayed ? 200 : 201,
        body: operationDto(operation, histories.get(operation.id) ?? [], await releases.current()),
        headers: result.replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        operationId: result.operationId,
      };
    },
  };
}
