type Level = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

let serviceName = 'bank-core';

export function setLogService(name: string): void {
  serviceName = name;
}

function write(level: Level, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify(
    { ts: new Date().toISOString(), level, service: serviceName, message, ...fields },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  process.stdout.write(`${line}\n`);
}

export const logger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
