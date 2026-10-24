import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { expireDueQrCodes } from './qr.repository';

export interface QrSweepDeps {
  pool: Pool;
  clock: BankClock;
}

export async function expireQrCodes(deps: QrSweepDeps): Promise<number> {
  return expireDueQrCodes(deps.pool, deps.clock.now());
}
