import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../config';
import { digest, durableJson, secret } from './durable';
import { PanelError } from './errors';
import type { PanelState } from './types';

export function kitFingerprint(runtime: Runtime): string {
  return process.env.KIT_FINGERPRINT ?? digest(runtime.hostDir.replace(/\/+$/, ''));
}

export class PanelStore {
  state: PanelState;
  readonly directory: string;
  readonly key: string;
  readonly internalKey: string;
  readonly fingerprint: string;
  constructor(runtime: Runtime) {
    this.directory = join(runtime.dataDir, 'panel');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    this.fingerprint = kitFingerprint(runtime);
    this.key = this.loadSecret('signing-key'); this.internalKey = this.loadSecret('internal-key');
    const path = join(this.directory, 'state.json');
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as PanelState : { schema: 1, fingerprint: this.fingerprint, revision: 0, startupDone: false, bootstraps: {}, sessions: [], plans: {}, operations: [], tombstones: {}, consumed: [], devices: {} };
    if (this.state.schema !== 1 || this.state.fingerprint !== this.fingerprint) throw new PanelError(409, 'KIT_CONFLICT', 'Данные контроллера принадлежат другому набору или имеют несовместимый формат');
    this.commit((state) => {
      for (const op of state.operations) if (!op.handoff && ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION'].includes(op.state)) { op.state = 'INTERRUPTED'; op.cancelAllowed = false; op.retryAllowed = true; op.stage = 'Проверить состояние'; op.updatedAt = new Date().toISOString(); }
    });
  }
  private loadSecret(name: string): string {
    const path = join(this.directory, name);
    if (!existsSync(path)) writeFileSync(path, secret(), { flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600); return readFileSync(path, 'utf8').trim();
  }
  commit(change: (next: PanelState) => void): void {
    const next = structuredClone(this.state); change(next); next.revision += 1;
    durableJson(join(this.directory, 'state.json'), next); this.state = next;
  }
  retain(now = Date.now()): void {
    this.commit((state) => {
      const since = now - 30 * 86400_000;
      const pending = state.operations.filter((op) => op.handoff && ['prepared', 'switching'].includes(op.handoff.phase));
      state.operations = [...state.operations.filter((op) => !pending.includes(op) && Date.parse(op.updatedAt) >= since).slice(-(200 - pending.length)), ...pending];
      for (const [key, value] of Object.entries(state.tombstones)) if (value.at < since) delete state.tombstones[key];
      for (const [key, plan] of Object.entries(state.plans)) if (Date.parse(plan.expiresAt) < now) delete state.plans[key];
      for (const [key, expires] of Object.entries(state.bootstraps)) if (expires < now) delete state.bootstraps[key];
      state.sessions = state.sessions.filter((session) => session.expiresAt > now);
      const activeConfirmations = new Set(Object.keys(state.plans));
      state.consumed = state.consumed.filter((id) => activeConfirmations.has(id));
    });
  }
}
