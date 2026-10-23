import type { Db } from '../db/pool';
import { channelOf, type TransferChannel } from '../metrics/bank-metrics';
import type { OperationStatus } from '../payments/status';
import type { StatusChangedPayload } from './payloads';
import type { OutboxRecord } from './outbox.repository';
import { getTopics } from './topics';

export interface StatusObservation {
  operationId: string;
  operationNumber: string;
  channel: TransferChannel;
  previousStatus: string;
  status: OperationStatus;
  reasonCode: string | null;
  changedAt: string;
  durationSeconds: number;
  label: string | null;
}

export function isStatusChangedRecord(record: OutboxRecord): boolean {
  return record.destination === 'KAFKA' && record.topic === getTopics().statusChanged;
}

export async function observeStatusChange(db: Db, record: OutboxRecord): Promise<StatusObservation | null> {
  const payload = record.payload as StatusChangedPayload;
  const found = await db.query<{ type: string; created_at: Date; attempt_label: string | null }>(
    'SELECT type, created_at, attempt_label FROM operations WHERE id = $1',
    [payload.operationId],
  );
  const operation = found.rows[0];
  if (!operation) return null;
  return {
    operationId: payload.operationId,
    operationNumber: payload.operationNumber,
    channel: channelOf(operation.type),
    previousStatus: payload.previousStatus,
    status: payload.status as OperationStatus,
    reasonCode: payload.reasonCode,
    changedAt: payload.changedAt,
    durationSeconds: (Date.parse(payload.changedAt) - operation.created_at.getTime()) / 1000,
    label: operation.attempt_label,
  };
}
