import type { BankMetrics } from '../metrics/bank-metrics';
import { logger } from '../shared/logger';
import type { StatusObservation } from './status-observation';

export function reportStatusChange(metrics: BankMetrics): (observation: StatusObservation) => void {
  return (observation) => {
    metrics.recordStatus(observation.channel, observation.status, observation.previousStatus, observation.durationSeconds);
    logger.info('operation status changed', {
      operationId: observation.operationId,
      operationNumber: observation.operationNumber,
      status: observation.status,
      previousStatus: observation.previousStatus,
      channel: observation.channel,
      bankTime: observation.changedAt,
      ...(observation.reasonCode === null ? {} : { reasonCode: observation.reasonCode }),
      ...(observation.label === null ? {} : { label: observation.label }),
    });
  };
}
