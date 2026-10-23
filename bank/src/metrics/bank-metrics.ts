import { Counter, Histogram, Registry } from 'prom-client';
import { OPERATION_STATUSES, isTerminal, type OperationStatus } from '../payments/status';

export const TRANSFER_CHANNELS = ['PHONE', 'OWN'] as const;
export type TransferChannel = (typeof TRANSFER_CHANNELS)[number];

export const SBP_RESULTS = ['accepted', 'rejected', 'unavailable', 'timeout'] as const;
export type SbpResult = (typeof SBP_RESULTS)[number];

const DURATION_BUCKETS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 60, 120, 300];

export function channelOf(type: string): TransferChannel {
  return type === 'PHONE_TRANSFER' ? 'PHONE' : 'OWN';
}

export class BankMetrics {
  readonly registry = new Registry();
  private readonly transfers = new Counter({
    name: 'bank_transfers_total',
    help: 'Переводы по способу и статусу, в котором они побывали',
    labelNames: ['channel', 'status'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'bank_transfer_duration_seconds',
    help: 'Время от создания перевода до конечного статуса',
    labelNames: ['channel'],
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });
  private readonly sbp = new Counter({
    name: 'bank_sbp_requests_total',
    help: 'Ответы СБП на запросы банка',
    labelNames: ['result'],
    registers: [this.registry],
  });

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    for (const channel of TRANSFER_CHANNELS) {
      for (const status of OPERATION_STATUSES) this.transfers.inc({ channel, status }, 0);
      this.duration.zero({ channel });
    }
    for (const result of SBP_RESULTS) this.sbp.inc({ result }, 0);
  }

  recordStatus(channel: TransferChannel, status: OperationStatus, previousStatus: string, durationSeconds: number): void {
    if (previousStatus === 'CREATED') this.transfers.inc({ channel, status: 'CREATED' });
    this.transfers.inc({ channel, status });
    if (isTerminal(status)) this.duration.observe({ channel }, Math.max(0, durationSeconds));
  }

  recordSbp(result: SbpResult): void {
    this.sbp.inc({ result });
  }

  reset(): void {
    this.registry.resetMetrics();
    this.initialize();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

export const bankMetrics = new BankMetrics();
