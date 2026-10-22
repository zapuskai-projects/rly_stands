import { executor, sleep, type ExecutorTable } from './types';

export const KIT_EXECUTORS: ExecutorTable = {
  'kit.wait': executor<{ seconds: number }>(async ({ seconds }) => {
    await sleep(seconds * 1000);
    return { waited: seconds };
  }),
};
