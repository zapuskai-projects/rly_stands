import { ProbeError } from './errors';
import { executor, type ExecutorTable } from './types';

export const PLATFORM_EXECUTORS: ExecutorTable = {
  'platform.report': executor<Record<string, string>>(async (params, ctx) => {
    if (!ctx.saveReport) throw new ProbeError('Баг-репорт можно заполнить только внутри попытки задачи');
    await ctx.saveReport(params);
    return { saved: true };
  }),

  'platform.answer': executor<Record<string, string>>(async (params, ctx) => {
    if (!ctx.saveReport) throw new ProbeError('Ответ можно записать только внутри попытки задачи');
    await ctx.saveReport(params);
    return { saved: true };
  }),
};
