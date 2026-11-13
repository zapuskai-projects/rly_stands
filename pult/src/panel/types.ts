import type { Handoff } from './handoff';
import type { ActionPlan, ActionRequest, ActionResult } from '../actions/types';

export type PlanRequest = { action: ActionRequest['action']; target?: string; clientRequestId: string; version?: string };
export type PanelPlan = ActionPlan & { planId: string; expiresAt: string; clientRequestId: string; payload: ActionRequest; kitFingerprint: string; uiBuildId: string; revision: string; confirmationToken?: string; signature: string };
export type OperationState = 'QUEUED' | 'RUNNING' | 'WAITING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export type Operation = {
  handoff?: Handoff;
  id: string; requestId: string; payloadHash: string; uiBuildId: string; action: ActionRequest; targets: string[];
  state: OperationState; stage: string; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  observedStateBefore: unknown; observedStateAfter?: unknown; result?: ActionResult; error?: { code: string; message: string };
  cancelAllowed: boolean; retryAllowed: boolean; confirmation?: string; events: Array<{ at: string; kind: string; text: string }>;
};
export type LocalSession = { id: string; csrf: string; fingerprint: string; expiresAt: number };
export type DeviceRecord = { id: string; code: string; verifyUrl: string | null; expiresAt: string; intervalSec: number; token: string; status: string; nextPollAt: number; message?: string };
export type PanelState = {
  schema: 1; fingerprint: string; revision: number; startupDone: boolean;
  bootstraps: Record<string, number>; sessions: LocalSession[]; plans: Record<string, PanelPlan>;
  operations: Operation[]; tombstones: Record<string, { operationId: string; payloadHash: string; at: number }>;
  consumed: string[]; devices: Record<string, DeviceRecord>;
};
