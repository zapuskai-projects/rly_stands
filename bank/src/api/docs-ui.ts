import { readFileSync } from 'node:fs';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { OPENAPI_PATH, PARTNER_OPENAPI_PATH } from '../config';
import { type Release } from '../release/release';
import type { ReleaseSource } from '../release/release-source';
import { specForRelease } from '../release/spec-filter';
import { notFoundHandler } from './errors';

export function mountDocs(
  app: Express,
  releases: ReleaseSource,
  source = readFileSync(OPENAPI_PATH, 'utf8'),
  partnerSource = readFileSync(PARTNER_OPENAPI_PATH, 'utf8'),
): void {
  const rendered = new Map<Release, string>();
  const renderFor = (current: Release): string => {
    const known = rendered.get(current);
    if (known !== undefined) return known;
    const text = specForRelease(source, current);
    rendered.set(current, text);
    return text;
  };
  app.get('/api/openapi.yaml', async (_req: Request, res: Response) => {
    res.type('text/yaml; charset=utf-8').send(renderFor(await releases.current()));
  });
  const mainUi = { swaggerUrl: '/api/openapi.yaml', customSiteTitle: 'ЗапускБанк API' };
  app.use('/api/docs', swaggerUi.serveFiles(undefined, mainUi), swaggerUi.setup(undefined, mainUi));
  const partnerAvailable: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    releases.atLeast('1.2').then(
      (available) => (available ? next() : notFoundHandler(req, res)),
      (error: unknown) => next(error),
    );
  };
  app.get('/api/partner-openapi.yaml', partnerAvailable, async (_req: Request, res: Response) => {
    res.type('text/yaml; charset=utf-8').send(specForRelease(partnerSource, await releases.current()));
  });
  const partnerUi = { swaggerUrl: '/api/partner-openapi.yaml', customSiteTitle: 'ЗапускБанк · партнёрское API' };
  app.use('/api/partner-docs', partnerAvailable, swaggerUi.serveFiles(undefined, partnerUi), swaggerUi.setup(undefined, partnerUi));
}
