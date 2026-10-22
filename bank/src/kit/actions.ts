import type { Pool } from 'pg';
import { findPrimaryAccount } from '../accounts/accounts.repository';
import type { BankClock } from '../clock/bank-clock';
import { findClientByPhone } from '../clients/clients.repository';
import { findOperationOfAnyClient } from '../payments/operations.repository';
import type { TransferCommand } from '../payments/transfer-command';
import { createTransfer } from '../payments/transfer.service';
import { approveReview, rejectReview } from '../review/review.service';
import type { RecipientNameLookup } from '../sbp/gateway';
import { BANK } from '../shared/bank-identity';
import { notFound, unprocessable } from '../shared/errors';
import type { ReviewActionInput, TariffPatchInput, TransferActionInput } from './schemas';
import { applyTariffPatch, tariffFact, type TariffFact } from './tariffs';

export interface KitActionDeps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient: RecipientNameLookup;
}

export interface KitTransferResult {
  operationId: string;
  number: string;
  status: string;
  clientId: string;
  replayed: boolean;
  rejectCode: string | null;
}

const OPERATOR = 'kit';
const DEFAULT_REJECT_COMMENT = 'Отклонено по сценарию проверки';

async function buildCommand(deps: KitActionDeps, clientId: string, input: TransferActionInput): Promise<TransferCommand> {
  const from = input.fromAccount ?? (await findPrimaryAccount(deps.pool, clientId))?.number;
  if (!from) throw unprocessable('ACCOUNT_NOT_FOUND', 'У клиента нет счёта списания');
  if (input.toOwnAccount !== undefined) {
    return { type: 'OWN_TRANSFER', fromAccount: from, toAccount: input.toOwnAccount, amount: BigInt(input.amountKop), comment: null };
  }
  return {
    type: 'PHONE_TRANSFER',
    fromAccount: from,
    recipientPhone: input.toPhone as string,
    recipientBankCode: input.toBankCode ?? BANK.code,
    amount: BigInt(input.amountKop),
    comment: null,
  };
}

export async function runTransfer(deps: KitActionDeps, input: TransferActionInput, requestId: string): Promise<KitTransferResult> {
  const client = await findClientByPhone(deps.pool, input.phone);
  if (!client) throw notFound('CLIENT_NOT_FOUND', `Клиента с телефоном ${input.phone} нет`);
  const created = await createTransfer(deps, {
    clientId: client.id,
    idempotencyKey: input.idempotencyKey,
    command: await buildCommand(deps, client.id, input),
    requestId,
    attemptLabel: input.label,
  });
  const operation = await findOperationOfAnyClient(deps.pool, created.operationId);
  return {
    operationId: created.operationId,
    number: operation?.number as string,
    status: operation?.status as string,
    clientId: client.id,
    replayed: created.replayed,
    rejectCode: operation?.rejectCode ?? null,
  };
}

export async function runSetTariff(deps: KitActionDeps, patch: TariffPatchInput): Promise<TariffFact> {
  return tariffFact(await applyTariffPatch(deps.pool, patch));
}

export async function runReview(deps: KitActionDeps, input: ReviewActionInput, requestId: string) {
  const item =
    input.decision === 'APPROVE'
      ? await approveReview(deps, input.operationId, OPERATOR, input.comment ?? null, requestId)
      : await rejectReview(deps, input.operationId, OPERATOR, input.comment ?? DEFAULT_REJECT_COMMENT, requestId);
  const operation = await findOperationOfAnyClient(deps.pool, input.operationId);
  return { operationId: item.operationId, state: item.state, status: operation?.status ?? item.operationStatus };
}
