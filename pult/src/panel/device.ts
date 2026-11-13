import { fetchSession } from '../platform/client';
import { deviceLoginStatus, generateKitToken, startDeviceLogin, tokenFingerprint } from '../platform/device';
import { rememberLogin } from '../actions/session';
import type { Controller } from './controller';
import { PanelError } from './errors';
import type { DeviceRecord } from './types';

const publicDevice = ({ token: _token, nextPollAt: _next, ...record }: DeviceRecord) => record;
export class DeviceLogins {
  private pending = false;
  constructor(private controller: Controller) {}
  async start() {
    const controller = this.controller;
    if (this.pending || controller.active()) throw new PanelError(409, 'OPERATION_CONFLICT', 'Дождитесь текущей операции');
    this.pending = true;
    try {
      const existing = Object.values(controller.store.state.devices).find((row) => row.status === 'PENDING' && Date.parse(row.expiresAt) > Date.now());
      if (existing) return publicDevice(existing);
      const token = generateKitToken();
      const result = await startDeviceLogin(controller.runtime.platformUrl, tokenFingerprint(token), controller.runtime.version);
      if (!result.ok) throw new PanelError(503, 'PLATFORM_UNAVAILABLE', result.message);
      const record: DeviceRecord = { ...result.value, token, status: 'PENDING', nextPollAt: 0 };
      controller.store.commit((state) => { state.devices[record.id] = record; });
      return publicDevice(record);
    } finally { this.pending = false; }
  }
  async get(id: string) {
    const controller = this.controller;
    let record = controller.store.state.devices[id];
    if (!record) throw new PanelError(404, 'LOGIN_UNKNOWN', 'Подключение не найдено');
    if (record.status !== 'PENDING' || this.pending || controller.active() || record.nextPollAt > Date.now()) return publicDevice(record);
    if (Date.parse(record.expiresAt) <= Date.now()) {
      controller.store.commit((state) => { state.devices[id]!.status = 'EXPIRED'; state.devices[id]!.token = ''; });
      return publicDevice(controller.store.state.devices[id]!);
    }
    this.pending = true;
    try {
      controller.store.commit((state) => { state.devices[id]!.nextPollAt = Date.now() + Math.max(1, record!.intervalSec) * 1000; });
      const status = await deviceLoginStatus(controller.runtime.platformUrl, id);
      if (!status.ok) {
        controller.store.commit((state) => { state.devices[id]!.message = status.message; });
      } else if (status.value === 'APPROVED') {
        const session = await fetchSession(controller.runtime.platformUrl, record.token, controller.runtime.version);
        if (session.ok) {
          rememberLogin(controller.runtime, record.token, session.session);
          controller.store.commit((state) => { state.devices[id]!.status = 'APPROVED'; state.devices[id]!.token = ''; });
          setImmediate(() => { void controller.ensureStarted().catch(() => undefined); });
        } else controller.store.commit((state) => { state.devices[id]!.message = session.message; });
      } else if (status.value !== 'PENDING') controller.store.commit((state) => { state.devices[id]!.status = status.value; state.devices[id]!.token = ''; });
      record = controller.store.state.devices[id]!;
      return publicDevice(record);
    } finally { this.pending = false; }
  }
}
