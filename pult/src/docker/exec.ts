import { execFile, spawn } from 'node:child_process';

export type ExecResult = { code: number; stdout: string; stderr: string };

type ExecOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string };

export function run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: options.env ?? process.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function runStreaming(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  options: ExecOptions = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    const feed = (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() ?? '';
      for (const part of parts) if (part.trim()) onLine(part.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', () => resolve(1));
    child.on('close', (code) => {
      if (pending.trim()) onLine(pending.trim());
      resolve(code ?? 1);
    });
  });
}
