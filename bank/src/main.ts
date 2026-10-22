import { loadConfig } from './config';
import { runAntifraud } from './roles/antifraud';
import { runCore } from './roles/core';
import { runSbp } from './roles/sbp';
import { logger, setLogService } from './shared/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogService(`bank-${config.role}`);
  if (config.role === 'antifraud') await runAntifraud(config);
  else if (config.role === 'sbp') await runSbp(config);
  else await runCore(config);
}

main().catch((error: unknown) => {
  logger.error('bank failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
