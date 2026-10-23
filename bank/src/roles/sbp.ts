import type { Config } from '../config';
import { buildSbpApp } from '../sbp/sbp-app';
import { loadScenarioLabel } from '../scenario/scenario.repository';
import { bindLogContext } from '../shared/log-shipper';
import { logger } from '../shared/logger';
import { connectDatabase, onShutdown } from './common';

export async function runSbp(config: Config): Promise<void> {
  const pool = await connectDatabase(config);
  bindLogContext({ label: () => loadScenarioLabel(pool) });
  const app = buildSbpApp({ pool, minDelayMs: config.sbpMinDelayMs, maxDelayMs: config.sbpMaxDelayMs });
  const server = app.listen(config.port, '0.0.0.0', () => logger.info('bank sbp started', { port: config.port }));
  onShutdown(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });
}
