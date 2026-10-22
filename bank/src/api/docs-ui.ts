import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { OPENAPI_PATH } from '../config';
import type { Contract } from './contract';

export function mountDocs(app: Express, contract: Contract): void {
  const source = readFileSync(OPENAPI_PATH, 'utf8');
  app.get('/api/openapi.yaml', (_req: Request, res: Response) => {
    res.type('text/yaml; charset=utf-8').send(source);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(contract.document, { customSiteTitle: 'ЗапускБанк API' }),
  );
}
