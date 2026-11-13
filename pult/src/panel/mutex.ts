import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PanelError } from './errors';

export async function acquireWriter(dataDir: string): Promise<() => Promise<void>> {
  mkdirSync(dataDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const path = join(dataDir, 'writer.lock');
    const command = process.platform === 'darwin' ? 'python3' : 'flock';
    const args = process.platform === 'darwin'
      ? ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("LOCKED",flush=True); sys.stdin.read()', path]
      : ['-n', '-E', '73', path, 'sh', '-c', 'printf "LOCKED\\n"; cat >/dev/null'];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let held = false;
    let released = false;
    child.stdin.on('error', () => undefined);
    child.stdout.once('data', () => { held = true; resolve(() => new Promise<void>((done) => { released = true; child.once('exit', () => done()); child.stdin.end(); })); });
    child.on('error', (error) => reject(new PanelError(503, 'LOCK_UNAVAILABLE', error.message)));
    child.on('exit', () => {
      if (!held) reject(new PanelError(409, 'WRITER_BUSY', 'Другой пульт уже выполняет действие или запускается; повторите запрос'));
      else if (!released) process.exit(74);
    });
  });
}
