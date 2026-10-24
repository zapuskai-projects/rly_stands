import type { Pool } from 'pg';
import { fromApiAmount } from '../../accounts/money';
import { runAutopaymentNow } from '../../autopayments/autopay-runner';
import { findClientAutopayment, listAutopaymentRuns, listClientAutopayments } from '../../autopayments/autopayments.repository';
import { cancelAutopayment, createAutopayment, pauseAutopayment, resumeAutopayment } from '../../autopayments/autopayments.service';
import type { BankClock } from '../../clock/bank-clock';
import type { RecipientNameLookup } from '../../sbp/gateway';
import { notFound } from '../../shared/errors';
import { autopaymentDto, runDto } from '../dto-templates';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient: RecipientNameLookup;
}

interface CreateBody {
  templateId: string;
  dayOfMonth: number;
  amount?: number;
  endsOn?: string;
}

const clientIdOf = (ctx: HandlerContext): string => (ctx.session as { clientId: string }).clientId;
const autopaymentIdOf = (ctx: HandlerContext): string => String(ctx.params.autopaymentId);

export function autopaymentHandlers({ pool, clock, lookupRecipient }: Deps): Record<string, Handler> {
  const deps = { pool, clock, lookupRecipient };
  return {
    listAutopayments: async (ctx) => ({ status: 200, body: { items: (await listClientAutopayments(pool, clientIdOf(ctx))).map(autopaymentDto) } }),
    createAutopayment: async (ctx) => {
      const body = ctx.body as CreateBody;
      const created = await createAutopayment(deps, clientIdOf(ctx), {
        templateId: body.templateId,
        dayOfMonth: body.dayOfMonth,
        amount: body.amount === undefined ? undefined : fromApiAmount(body.amount),
        endsOn: body.endsOn,
      });
      return { status: 201, body: autopaymentDto(created) };
    },
    pauseAutopayment: async (ctx) => ({ status: 200, body: autopaymentDto(await pauseAutopayment(deps, clientIdOf(ctx), autopaymentIdOf(ctx))) }),
    resumeAutopayment: async (ctx) => ({ status: 200, body: autopaymentDto(await resumeAutopayment(deps, clientIdOf(ctx), autopaymentIdOf(ctx))) }),
    cancelAutopayment: async (ctx) => ({ status: 200, body: autopaymentDto(await cancelAutopayment(deps, clientIdOf(ctx), autopaymentIdOf(ctx))) }),
    listAutopaymentRuns: async (ctx) => {
      const id = autopaymentIdOf(ctx);
      if (!(await findClientAutopayment(pool, clientIdOf(ctx), id))) throw notFound('AUTOPAYMENT_NOT_FOUND', 'Автоплатёж не найден');
      return { status: 200, body: { items: (await listAutopaymentRuns(pool, id)).map(runDto) } };
    },
    runSandboxAutopayment: async (ctx) => {
      const result = await runAutopaymentNow(deps, clientIdOf(ctx), autopaymentIdOf(ctx), { requestId: ctx.requestId, attemptLabel: ctx.attemptLabel });
      return {
        status: 200,
        body: { run: runDto(result.run), autopayment: autopaymentDto(result.autopayment) },
        operationId: result.run.operationId ?? undefined,
      };
    },
  };
}
