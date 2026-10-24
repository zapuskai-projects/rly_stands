import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import type { RecipientNameLookup } from '../sbp/gateway';
import type { Readiness } from '../shared/readiness';
import { loadContract, type Contract } from './contract';
import { DOCS_DIR, PARTNER_OPENAPI_PATH, WEB_DIR } from '../config';
import { mountKit } from '../kit/routes';
import type { BankMetrics } from '../metrics/bank-metrics';
import { mountMetrics } from '../metrics/route';
import { databaseReleaseSource } from '../release/release-source';
import { mountDocsContent } from './docs-content';
import { mountDocs } from './docs-ui';
import { mountWeb } from './web';
import { errorHandler, notFoundHandler } from './errors';
import { authHandlers } from './handlers/auth';
import { autopaymentHandlers } from './handlers/autopayments';
import { accountHandlers } from './handlers/accounts';
import { officeHandlers } from './handlers/office';
import { officeAuthHandlers } from './handlers/office-auth';
import { officeClientHandlers } from './handlers/office-clients';
import { officeOperationHandlers } from './handlers/office-operations';
import { officeSettingsHandlers } from './handlers/office-settings';
import { partnerHandlers } from './handlers/partner';
import { qrPaymentHandlers } from './handlers/qr-payments';
import { recipientHandlers } from './handlers/recipients';
import { referenceHandlers } from './handlers/reference';
import { templateHandlers } from './handlers/templates';
import { transferHandlers } from './handlers/transfers';
import { createRequestJournal, requestContext } from './request-context';
import { registerOperations } from './router';

export interface AppDeps {
  pool: Pool;
  clock: BankClock;
  contract: Contract;
  partnerContract?: Contract;
  lookupRecipient: RecipientNameLookup;
  kitSecret?: string | null;
  readiness?: Readiness;
  metrics?: BankMetrics;
  afterReset?: () => Promise<void>;
}

export function buildApp({ pool, clock, contract, partnerContract = loadContract(PARTNER_OPENAPI_PATH), lookupRecipient, kitSecret = null, readiness, metrics, afterReset }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(clock, pool));
  const journal = createRequestJournal(pool, clock);
  const releases = databaseReleaseSource(pool);
  app.use(journal.middleware);
  mountDocs(app, releases);
  mountDocsContent(app, DOCS_DIR, releases);
  if (metrics) mountMetrics(app, metrics);
  mountKit(app, { pool, clock, secret: kitSecret, lookupRecipient, journal, afterReset });
  app.use(express.json({ limit: '64kb' }));
  registerOperations(
    app,
    contract,
    {
      ...authHandlers({ pool, clock }),
      ...accountHandlers({ pool, clock, releases }),
      ...transferHandlers({ pool, clock, lookupRecipient, releases }),
      ...templateHandlers({ pool, clock, lookupRecipient, releases }),
      ...autopaymentHandlers({ pool, clock, lookupRecipient }),
      ...qrPaymentHandlers({ pool, clock, releases }),
      ...recipientHandlers({ pool, lookupRecipient }),
      ...officeHandlers({ pool, clock, releases }),
      ...officeAuthHandlers(pool),
      ...officeClientHandlers({ pool, clock, releases }),
      ...officeOperationHandlers(pool, releases),
      ...officeSettingsHandlers(pool),
      ...referenceHandlers(pool, releases, readiness),
    },
    { pool, clock },
    releases,
  );
  registerOperations(app, partnerContract, partnerHandlers({ pool, clock }), { pool, clock }, releases);
  mountWeb(app, WEB_DIR);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
