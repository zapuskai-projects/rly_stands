import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/pool';
import { loadRelease } from '../scenario/scenario.repository';
import { releaseAtLeast, type Release } from './release';

export interface ReleaseSource {
  current(): Promise<Release>;
  atLeast(required: Release): Promise<boolean>;
}

export function releaseSource(load: () => Promise<Release>): ReleaseSource {
  return {
    current: load,
    atLeast: async (required) => releaseAtLeast(await load(), required),
  };
}

export function databaseReleaseSource(db: Db): ReleaseSource {
  return releaseSource(() => loadRelease(db));
}

export function requireRelease(source: ReleaseSource, required: Release): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    source.atLeast(required).then(
      (available) => next(available ? undefined : 'route'),
      (error: unknown) => next(error),
    );
  };
}
