import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import type { RecipientNameLookup } from '../sbp/gateway';
import type { Readiness } from '../shared/readiness';
import type { Contract } from './contract';
import { DOCS_DIR, WEB_DIR } from '../config';
import { mountKit } from '../kit/routes';
import { mountDocsContent } from './docs-content';
import { mountDocs } from './docs-ui';
import { mountWeb } from './web';
import { errorHandler, notFoundHandler } from './errors';
import { authHandlers } from './handlers/auth';
import { accountHandlers } from './handlers/accounts';
import { officeHandlers } from './handlers/office';
import { officeAuthHandlers } from './handlers/office-auth';
import { officeClientHandlers } from './handlers/office-clients';
import { officeOperationHandlers } from './handlers/office-operations';
import { officeSettingsHandlers } from './handlers/office-settings';
import { recipientHandlers } from './handlers/recipients';
import { referenceHandlers } from './handlers/reference';
import { transferHandlers } from './handlers/transfers';
import { createRequestJournal, requestContext } from './request-context';
import { registerOperations } from './router';

export interface AppDeps {
  pool: Pool;
  clock: BankClock;
  contract: Contract;
  lookupRecipient: RecipientNameLookup;
  kitSecret?: string | null;
  readiness?: Readiness;
}

export function buildApp({ pool, clock, contract, lookupRecipient, kitSecret = null, readiness }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(clock, pool));
  const journal = createRequestJournal(pool, clock);
  app.use(journal.middleware);
  mountDocs(app, contract);
  mountDocsContent(app, DOCS_DIR);
  mountKit(app, { pool, clock, secret: kitSecret, lookupRecipient, journal });
  app.use(express.json({ limit: '64kb' }));
  registerOperations(
    app,
    contract,
    {
      ...authHandlers({ pool, clock }),
      ...accountHandlers({ pool, clock }),
      ...transferHandlers({ pool, clock, lookupRecipient }),
      ...recipientHandlers({ pool, lookupRecipient }),
      ...officeHandlers({ pool, clock }),
      ...officeAuthHandlers(pool),
      ...officeClientHandlers({ pool, clock }),
      ...officeOperationHandlers(pool),
      ...officeSettingsHandlers(pool),
      ...referenceHandlers(pool, readiness),
    },
    { pool, clock },
  );
  mountWeb(app, WEB_DIR);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
