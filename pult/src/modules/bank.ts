import { run } from '../docker/exec';

export const BANK_DATABASE = 'bank';

const POSTGRES_CONTAINER = 'stands-kit-postgres';
const POSTGRES_ARGS = ['exec', POSTGRES_CONTAINER, 'psql', '-U', 'student', '-d', 'student', '-v', 'ON_ERROR_STOP=1', '-tAc'];

export async function dropBankDatabase(): Promise<void> {
  await run('docker', [...POSTGRES_ARGS, `DROP DATABASE IF EXISTS ${BANK_DATABASE} WITH (FORCE)`]);
}
