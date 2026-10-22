import { randomBytes } from 'node:crypto';
import { BANK_EXECUTORS } from './bank';
import { accepted, fetchOperation, resolveBankTime } from './bank-api';
import { ProbeError } from './errors';
import { asArray, asRecord, num, str } from './http';
import { executor, sleep, type ExecutorTable, type ProbeContext } from './types';

const FINAL = new Set(['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);
const POLL_MS = 500;
const CLOCK_SYNC_MS = 2500;
const DEFAULT_TIMEOUT_MS = 60_000;
const KEY_MAX = 64;
const RUN_CLIENT = 'client';
const RUN_RECIPIENT = 'recipient';

type Scenario = Record<string, unknown>;
type Review = { decision: string; comment?: string; operation?: number };
type Step = { scenario?: Scenario; transfer?: Record<string, unknown>; review?: Review; wait?: number };
type RunClient = { tariffCode: string; balanceKop: number };
type RunParams = { client?: RunClient; recipient?: RunClient; steps: Step[]; timeoutMs?: number };
type Technical = { phone: string; accountNumber: string };
type Tracked = { step: number; id: string; number: string; fact: Record<string, unknown> | null };

const pause = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export function withRunId(key: string, runId: string): string {
  const suffix = `-${runId}`;
  return `${key.slice(0, KEY_MAX - suffix.length)}${suffix}`;
}

export function transitionsOf(history: unknown): string[] {
  const statuses = asArray(history).map((entry) => str(asRecord(entry).status));
  return statuses.slice(1).map((status, index) => `${statuses[index]} -> ${status}`);
}

function operationRow(item: Tracked) {
  const fact = item.fact ?? {};
  const statusHistory = asArray(fact.statusHistory);
  return {
    step: item.step,
    id: item.id,
    number: item.number,
    status: str(fact.status),
    route: str(fact.route),
    amountKop: num(fact.amountKop),
    feeKop: num(fact.feeKop),
    reasonCode: typeof fact.reasonCode === 'string' ? fact.reasonCode : null,
    statusHistory,
    transitions: transitionsOf(statusHistory),
  };
}

async function runSteps(params: RunParams, ctx: ProbeContext) {
  const runId = randomBytes(2).toString('hex');
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const tracked: Tracked[] = [];
  let timedOut = false;

  let clock: string | null | undefined;
  let technical: Technical | null = null;
  let recipient: Technical | null = null;

  const apply = async (next: Scenario) => {
    const time = resolveBankTime(next.bankTime as string | null | undefined);
    await BANK_EXECUTORS['bank.scenario']!(next, ctx);
    if (time !== clock) await sleep(pause('KIT_BANK_CLOCK_SYNC_MS', CLOCK_SYNC_MS));
    clock = time;
  };

  const settle = async (item: Tracked, stop: (status: string) => boolean): Promise<void> => {
    for (;;) {
      item.fact = await fetchOperation(ctx, item.id);
      if (item.fact && stop(str(item.fact.status))) return;
      if (Date.now() >= deadline) {
        timedOut = true;
        return;
      }
      await sleep(pause('KIT_BANK_POLL_MS', POLL_MS));
    }
  };

  const createClient = async (definition: RunClient): Promise<Technical> => {
    const created = asRecord(await accepted(ctx, '/actions/check-client', definition, 'технический клиент прогона'));
    return { phone: str(created.phone), accountNumber: str(created.accountNumber) };
  };
  if (params.client) technical = await createClient(params.client);
  if (params.recipient) recipient = await createClient(params.recipient);

  for (const [index, step] of params.steps.entries()) {
    if (timedOut) break;
    if (step.scenario) {
      await apply({ ...step.scenario });
    } else if (step.transfer) {
      if (step.transfer.phone === RUN_CLIENT && !technical) {
        throw new ProbeError('В прогоне перевод от клиента прогона, а клиент не задан');
      }
      if (step.transfer.toPhone === RUN_RECIPIENT && !recipient) {
        throw new ProbeError('В прогоне перевод получателю прогона, а получатель не задан');
      }
      const sent = asRecord(
        await BANK_EXECUTORS['bank.transfer']!(
          {
            ...step.transfer,
            phone: step.transfer.phone === RUN_CLIENT ? technical?.phone : step.transfer.phone,
            toPhone: step.transfer.toPhone === RUN_RECIPIENT ? recipient?.phone : step.transfer.toPhone,
            idempotencyKey: withRunId(str(step.transfer.idempotencyKey), runId),
          },
          ctx,
        ),
      );
      const item: Tracked = { step: index, id: str(sent.operationId), number: str(sent.number), fact: null };
      tracked.push(item);
      await settle(item, (status) => FINAL.has(status) || status === 'ON_REVIEW');
    } else if (step.review) {
      const target = tracked.find((item) => item.step === step.review?.operation) ?? tracked.at(-1);
      if (!target) throw new ProbeError('В прогоне решение оператора стоит раньше любого перевода');
      if (str(target.fact?.status) === 'ON_REVIEW') {
        await BANK_EXECUTORS['bank.review']!(
          { operationId: target.id, decision: step.review.decision, comment: step.review.comment },
          ctx,
        );
        await settle(target, (status) => FINAL.has(status));
      }
    } else if (step.wait) {
      await sleep(Math.min(step.wait * 1000, Math.max(0, deadline - Date.now())));
    }
  }

  const operations = tracked.map(operationRow);
  return {
    completed: !timedOut,
    timedOut,
    client: technical,
    recipient,
    operations,
    transitions: [...new Set(operations.flatMap((operation) => operation.transitions))],
  };
}

export const BANK_RUN_EXECUTORS: ExecutorTable = {
  'bank.run': executor<RunParams>(runSteps),
};
