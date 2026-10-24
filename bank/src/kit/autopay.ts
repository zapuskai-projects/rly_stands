import type { Pool } from 'pg';
import { toApiAmount } from '../accounts/money';
import { runAutopaymentNow } from '../autopayments/autopay-runner';
import { listAutopaymentRuns, listClientAutopayments, listRunMarks } from '../autopayments/autopayments.repository';
import { toMoscowIso } from '../clock/moscow';
import type { BankClock } from '../clock/bank-clock';
import { listClientTemplates } from '../templates/templates.repository';
import type { RecipientNameLookup } from '../sbp/gateway';
import { notFound } from '../shared/errors';

export interface KitAutopayDeps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient: RecipientNameLookup;
}

interface OwnerRow {
  id: string;
  client_id: string;
}

export async function runKitAutopay(deps: KitAutopayDeps, autopaymentId: string, label: string, requestId: string) {
  const owner = await deps.pool.query<OwnerRow>('SELECT id, client_id FROM autopayments WHERE id = $1', [autopaymentId]);
  const row = owner.rows[0];
  if (!row) throw notFound('AUTOPAYMENT_NOT_FOUND', 'Автоплатёж не найден');
  const result = await runAutopaymentNow(deps, row.client_id, autopaymentId, { requestId, attemptLabel: label });
  return {
    clientId: row.client_id,
    operationId: result.run.operationId,
    body: {
      runId: result.run.id,
      attempt: result.run.attempt,
      outcome: result.run.outcome,
      operationId: result.run.operationId,
      operationNumber: result.run.operationNumber,
      reasonCode: result.run.reasonCode,
      autopaymentStatus: result.autopayment.status,
      nextRunOn: result.autopayment.nextRunOn,
    },
  };
}

export interface AutopayFilter {
  phone?: string;
  autopaymentId?: string;
}

export async function listAutopayFacts(db: Pool, filter: AutopayFilter) {
  const clients = await db.query<{ id: string; phone: string }>(
    'SELECT id, phone FROM clients WHERE ($1::text IS NULL OR phone = $1) ORDER BY number',
    [filter.phone ?? null],
  );
  const templates = [];
  const autopayments = [];
  for (const client of clients.rows) {
    for (const template of await listClientTemplates(db, client.id)) {
      templates.push({
        id: template.id,
        clientPhone: client.phone,
        name: template.name,
        kind: template.kind,
        fromAccount: template.fromAccountNumber,
        toAccount: template.toAccountNumber,
        recipientPhone: template.recipientPhone,
        recipientBankCode: template.recipientBankCode,
        amountKop: template.amount === null ? null : toApiAmount(template.amount),
      });
    }
    const owned = (await listClientAutopayments(db, client.id)).filter((item) => filter.autopaymentId === undefined || item.id === filter.autopaymentId);
    for (const autopayment of owned.reverse()) {
      const runs = (await listAutopaymentRuns(db, autopayment.id)).reverse();
      autopayments.push({
        id: autopayment.id,
        clientPhone: client.phone,
        templateId: autopayment.templateId,
        templateName: autopayment.templateName,
        status: autopayment.status,
        dayOfMonth: autopayment.dayOfMonth,
        amountKop: toApiAmount(autopayment.amount),
        endsOn: autopayment.endsOn,
        nextRunOn: autopayment.nextRunOn,
        attempt: autopayment.attempt,
        failureReason: autopayment.failureCode,
        runs: await Promise.all(runs.map(async (run) => ({
          id: run.id,
          runDate: run.runDate,
          cycleDate: run.cycleDate,
          attempt: run.attempt,
          outcome: run.outcome,
          operationId: run.operationId,
          operationNumber: run.operationNumber,
          reasonCode: run.reasonCode,
          amountKop: toApiAmount(run.amount),
          startedAt: toMoscowIso(run.startedAt),
          finishedAt: run.finishedAt ? toMoscowIso(run.finishedAt) : null,
          defects: await listRunMarks(db, run.id),
        }))),
      });
    }
  }
  return { templates, autopayments };
}
