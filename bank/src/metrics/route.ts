import type { Express } from 'express';
import type { BankMetrics } from './bank-metrics';

export function mountMetrics(app: Express, metrics: BankMetrics): void {
  app.get('/metrics', (_req, res, next) => {
    metrics
      .render()
      .then((body) => res.set('Content-Type', metrics.registry.contentType).send(body))
      .catch(next);
  });
}
