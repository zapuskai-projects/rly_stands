export type ReportSaver = (report: Record<string, string>) => Promise<void>;

export type ProbeContext = {
  workDir: string;
  label: string;
  dataDir?: string;
  results?: Record<string, Record<string, unknown>>;
  saveReport?: ReportSaver;
};

export type Executor = (params: Record<string, unknown>, ctx: ProbeContext) => Promise<unknown>;

export type ExecutorTable = Record<string, Executor>;

export function executor<P>(handler: (params: P, ctx: ProbeContext) => Promise<unknown>): Executor {
  return (params, ctx) => handler(params as unknown as P, ctx);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
