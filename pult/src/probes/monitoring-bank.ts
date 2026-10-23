import { randomBytes } from 'node:crypto';
import { BANK_EXECUTORS } from './bank';
import { accepted, call } from './bank-api';
import { asRecord, str } from './http';
import { sleep, type ProbeContext } from './types';

export const BANK_SBP_SCENARIO = 'bank-sbp-reject';

const DEFAULT_BANK_TIME = 'noon';
const TRAFFIC_INTERVAL_MS = 3000;
const CLOCK_SYNC_MS = 2500;
const TRANSFER_KOP = 10_000;
const CLIENT_BALANCE_KOP = 1_000_000_000;
const OTHER_BANK = { toPhone: '+79000000021', toBankCode: 'NORTHWIND' };

export type Incident = {
  prepare: () => Promise<void>;
  begin: () => Promise<void>;
  end: () => Promise<void>;
  transfersSent: () => number;
};

export function sbpScenario(sbpMode: 'NORMAL' | 'REJECT', bankTime: string | null) {
  return { reset: false, defects: [] as string[], sbpMode, bankTime };
}

export function trafficTransfer(clientPhone: string, runId: string, index: number) {
  return { phone: clientPhone, ...OTHER_BANK, amountKop: TRANSFER_KOP, idempotencyKey: `drill-${runId}-${index}` };
}

export function restoredBankTime(clock: { now: string; shifted: boolean }, elapsedMs: number): string | null {
  return clock.shifted ? new Date(Date.parse(clock.now) + elapsedMs).toISOString() : null;
}

async function readClock(ctx: ProbeContext): Promise<{ now: string; shifted: boolean } | null> {
  const result = await call(ctx, 'GET', '/facts/clock').catch(() => null);
  const body = asRecord(result?.json);
  return result?.ok && typeof body.now === 'string' ? { now: body.now, shifted: body.shifted === true } : null;
}

export type Traffic = { stop: () => Promise<number> };

export function startTraffic(
  send: (index: number) => Promise<unknown>,
  pause: (ms: number) => Promise<void> = sleep,
  intervalMs = TRAFFIC_INTERVAL_MS,
): Traffic {
  let stopped = false;
  let attempts = 0;
  let sent = 0;
  const loop = (async () => {
    while (!stopped) {
      const index = attempts;
      attempts += 1;
      await send(index).then(
        () => {
          sent += 1;
        },
        () => undefined,
      );
      await pause(intervalMs);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      return sent;
    },
  };
}

export function bankIncident(ctx: ProbeContext, bankTime = DEFAULT_BANK_TIME): Incident {
  let traffic: Traffic | null = null;
  let sent = 0;
  let before: { clock: { now: string; shifted: boolean }; at: number } | null = null;
  const scenario = (sbpMode: 'NORMAL' | 'REJECT', time: string | null = bankTime) =>
    BANK_EXECUTORS['bank.scenario']!(sbpScenario(sbpMode, time), ctx);
  return {
    prepare: async () => {
      const clock = await readClock(ctx);
      before = clock ? { clock, at: Date.now() } : null;
      await scenario('NORMAL');
      await sleep(Number(process.env.KIT_BANK_CLOCK_SYNC_MS ?? CLOCK_SYNC_MS));
      const client = asRecord(await accepted(ctx, '/actions/check-client', { tariffCode: 'START', balanceKop: CLIENT_BALANCE_KOP }, 'технический клиент учений'));
      const runId = randomBytes(2).toString('hex');
      traffic = startTraffic((index) => BANK_EXECUTORS['bank.transfer']!(trafficTransfer(str(client.phone), runId, index), ctx));
    },
    begin: async () => {
      await scenario('REJECT');
    },
    end: async () => {
      sent = (await traffic?.stop()) ?? 0;
      traffic = null;
      const restored = before ? restoredBankTime(before.clock, Date.now() - before.at) : bankTime;
      await scenario('NORMAL', restored).catch(() => undefined);
    },
    transfersSent: () => sent,
  };
}
