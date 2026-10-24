import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { OPENAPI_PATH } from '../config';
import { type Release } from '../release/release';
import type { ReleaseSource } from '../release/release-source';
import { specForRelease } from '../release/spec-filter';

export function mountDocs(app: Express, releases: ReleaseSource, source = readFileSync(OPENAPI_PATH, 'utf8')): void {
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
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, { swaggerUrl: '/api/openapi.yaml', customSiteTitle: 'ЗапускБанк API' }),
  );
}
