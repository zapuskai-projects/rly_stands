type Level = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface LogEntry {
  ts: string;
  level: Level;
  service: string;
  message: string;
  fields: LogFields;
}

export type LogSink = (entry: LogEntry) => void;

let serviceName = 'bank-core';
let sink: LogSink | null = null;

export function setLogService(name: string): void {
  serviceName = name;
}

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function line(entry: LogEntry): string {
  return JSON.stringify(
    { ts: entry.ts, level: entry.level, service: entry.service, message: entry.message, ...entry.fields },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

function write(level: Level, message: string, fields: LogFields = {}, ship = true): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, service: serviceName, message, fields };
  process.stdout.write(`${line(entry)}\n`);
  if (ship) sink?.(entry);
}

export const logger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};

export const localLogger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields, false),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields, false),
};
