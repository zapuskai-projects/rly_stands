import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { logger } from '../shared/logger';

const SERVER_PATHS = /^\/(api|partner|health|docs-content|sbp|assets|_kit)(\/|$)/;
const FILE_PATH = /\/[^/]*\.[A-Za-z0-9]+$/;

export function mountWeb(app: Express, directory: string): void {
  const index = path.join(directory, 'index.html');
  if (!existsSync(index)) {
    logger.warn('web build not found', { directory });
    return;
  }
  app.use('/assets', express.static(path.join(directory, 'assets'), { immutable: true, maxAge: '30d' }));
  app.use('/assets', (_req: Request, res: Response) => {
    res.status(404).end();
  });
  app.get(/^\/favicon\.svg$/, (_req: Request, res: Response) => {
    res.sendFile(path.join(directory, 'favicon.svg'));
  });
  app.get(/^\/.*$/, (req: Request, res: Response, next) => {
    if (SERVER_PATHS.test(req.path) || FILE_PATH.test(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
