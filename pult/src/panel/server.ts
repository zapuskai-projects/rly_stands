import { createServer, type Server } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../config';
import { Controller } from './controller';
import { durableJson, secret } from './durable';
import { acquireWriter } from './mutex';
import { Router, type PanelMeta } from './router';

export async function servePanel(runtime: Runtime): Promise<void> {
  const release = await acquireWriter(runtime.dataDir);
  const assets = process.env.KIT_PANEL_ASSETS ?? '/app/panel-web';
  let controller: Controller;
  let server: Server | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8')) as { uiBuildId: string; apiProtocolVersion: number };
    if (!manifest.uiBuildId?.startsWith(runtime.version + '-') || manifest.apiProtocolVersion !== 1) throw new Error('Несовместимый manifest панели');
    controller = new Controller(runtime, manifest.uiBuildId);
    const meta: PanelMeta = { instanceId: secret(), uiBuildId: manifest.uiBuildId, apiProtocolVersion: 1, version: runtime.version };
    const router = new Router(controller, meta, assets);
    await controller.reconcileInterrupted();
    server = createServer((req, res) => { void router.handle(req, res); });
    server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
    server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(18490, '0.0.0.0', resolve); });
    const marker = join(controller.store.directory, 'controller.json');
    durableJson(marker, { ...meta, fingerprint: controller.store.fingerprint });
    const tick = setInterval(() => {
      void controller.enforce().then(() => controller.ensureStarted()).catch(() => undefined);
    }, Math.min(runtime.agentIntervalSec * 1000, 30000));
    const retention = setInterval(() => { try { controller.store.retain(); } catch {} }, 3600000);
    const shutdown = () => {
      clearInterval(tick); clearInterval(retention);
      server!.close(() => {
        const finish = () => { if (controller.isWriting()) { setTimeout(finish, 100); return; } try { unlinkSync(marker); } catch {} void release(); };
        finish();
      });
      if (controller.isWriting()) return;
      server!.closeAllConnections();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    void controller.enforce().then(() => controller.ensureStarted()).catch(() => undefined);
  } catch (error) { server?.closeAllConnections(); server?.close(); await release(); throw error; }
}
