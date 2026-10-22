import { findClientAccountByNumber, findPrimaryAccount, type Account } from '../accounts/accounts.repository';
import type { Db } from '../db/pool';
import { findClientByPhone, type Client } from '../clients/clients.repository';
import { shortName } from '../clients/names';
import { BANK } from '../shared/bank-identity';
import { unprocessable } from '../shared/errors';
import type { RecipientNameLookup } from '../sbp/gateway';
import type { OperationRoute } from './operations.repository';
import type { TransferCommand } from './transfer-command';

export interface ResolvedTarget {
  route: OperationRoute;
  toAccount: Account | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientName: string | null;
}

async function resolveOwnAccount(
  db: Db,
  client: Client,
  source: Account,
  command: Extract<TransferCommand, { type: 'OWN_TRANSFER' }>,
): Promise<ResolvedTarget> {
  const target = await findClientAccountByNumber(db, client.id, command.toAccount);
  if (!target) throw unprocessable('ACCOUNT_NOT_FOUND', 'Счёт зачисления не найден среди ваших счетов');
  if (target.id === source.id) throw unprocessable('SAME_ACCOUNT', 'Счета списания и зачисления совпадают');
  return { route: 'INTERNAL', toAccount: target, recipientPhone: null, recipientBankCode: null, recipientName: null };
}

async function resolveBankClient(
  db: Db,
  client: Client,
  command: Extract<TransferCommand, { type: 'PHONE_TRANSFER' }>,
): Promise<ResolvedTarget> {
  const recipient = await findClientByPhone(db, command.recipientPhone);
  if (!recipient || recipient.status !== 'ACTIVE') {
    throw unprocessable('RECIPIENT_NOT_FOUND', 'Клиент ЗапускБанка с таким номером телефона не найден');
  }
  if (recipient.id === client.id) throw unprocessable('RECIPIENT_IS_SENDER', 'Нельзя перевести деньги самому себе по номеру телефона');
  const account = await findPrimaryAccount(db, recipient.id);
  if (!account || account.status === 'CLOSED') {
    throw unprocessable('RECIPIENT_NOT_FOUND', 'У получателя нет счёта для зачисления');
  }
  return {
    route: 'INTERNAL',
    toAccount: account,
    recipientPhone: command.recipientPhone,
    recipientBankCode: BANK.code,
    recipientName: shortName(recipient.fullName),
  };
}

async function resolvePartnerBank(
  db: Db,
  command: Extract<TransferCommand, { type: 'PHONE_TRANSFER' }>,
  lookup: RecipientNameLookup | undefined,
): Promise<ResolvedTarget> {
  const result = await db.query<{ code: string }>('SELECT code FROM partner_banks WHERE code = $1 AND active', [
    command.recipientBankCode,
  ]);
  if (!result.rows[0]) throw unprocessable('UNKNOWN_BANK', 'Банк получателя не найден в справочнике банков');
  return {
    route: 'SBP',
    toAccount: null,
    recipientPhone: command.recipientPhone,
    recipientBankCode: command.recipientBankCode,
    recipientName: (await lookup?.(command.recipientPhone, command.recipientBankCode)) ?? null,
  };
}

export async function resolveTarget(
  db: Db,
  client: Client,
  source: Account,
  command: TransferCommand,
  lookup?: RecipientNameLookup,
): Promise<ResolvedTarget> {
  if (command.type === 'OWN_TRANSFER') return resolveOwnAccount(db, client, source, command);
  if (command.recipientBankCode === BANK.code) return resolveBankClient(db, client, command);
  return resolvePartnerBank(db, command, lookup);
}
