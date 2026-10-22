export const OPERATION_STATUSES = [
  'CREATED',
  'CHECKING',
  'ON_REVIEW',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'REFUNDED',
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

const TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  CREATED: ['CHECKING'],
  CHECKING: ['ON_REVIEW', 'PROCESSING', 'REJECTED'],
  ON_REVIEW: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'REFUNDED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
  REFUNDED: [],
};

export const LIMIT_COUNTED_STATUSES: readonly OperationStatus[] = [
  'CREATED',
  'CHECKING',
  'ON_REVIEW',
  'PROCESSING',
  'COMPLETED',
];

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OperationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
