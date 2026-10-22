import type { Pool } from 'pg';
import { findClientAccountByNumber, findSystemAccount, lockAccounts, sumActiveHolds } from '../accounts/accounts.repository';
import { createHold } from '../accounts/ledger';
import { formatRubles, toApiAmount, type Kopecks } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { findClientById, findDailyLimitOverride, lockClientForTransfers, type Client } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import type { DefectMark, DefectSet } from '../defects/catalog';
import { insertDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import { limitDefectMarks, type LimitDefectFlags } from '../defects/limit-defects';
import { amountInRubles, paymentCreatedMessage } from '../events/builders';
import { enqueueOutbox } from '../events/outbox.repository';
import { getTopics } from '../events/topics';
import { forbidden, unprocessable } from '../shared/errors';
import { calculateCommission, calculateCommissionDroppingKopecks } from '../tariffs/commission';
import { effectiveDailyLimit } from '../tariffs/limits';
import { getTariff } from '../tariffs/tariffs.repository';
import { beginProcessing, requireLockedOperation } from './lifecycle';
import {
  findIdempotencyRecord,
  findOperationOfAnyClient,
  insertIdempotencyRecord,
  insertOperation,
  transitionOperation,
  type OperationRecord,
  type OperationRoute,
} from './operations.repository';
import { isTerminal } from './status';
import type { RecipientNameLookup } from '../sbp/gateway';
import { resolveTarget } from './recipient';
import { evaluateRejection } from './rejection';
import { hashTransferCommand, type TransferCommand } from './transfer-command';
import { loadPhoneTransferUsage } from './usage';

export interface TransferDeps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient?: RecipientNameLookup;
}

export interface CreateTransferInput {
  clientId: string;
  idempotencyKey: string;
  command: TransferCommand;
  requestId: string;
  attemptLabel: string | null;
}

export interface CreateTransferResult {
  operationId: string;
  replayed: boolean;
}

interface PhoneTransferEconomics {
  fee: Kopecks;
  correctFee: Kopecks;
  dailyLimit: Kopecks;
  usedToday: Kopecks;
  usedTodayByMoscowDay: Kopecks;
}

const NO_ECONOMICS: PhoneTransferEconomics = { fee: 0n, correctFee: 0n, dailyLimit: 0n, usedToday: 0n, usedTodayByMoscowDay: 0n };

interface TransferContext {
  defects: DefectSet;
  repeatOf: OperationRecord | null;
}

async function phoneTransferEconomics(
  db: Db,
  client: Client,
  route: OperationRoute,
  amount: Kopecks,
  now: Date,
  defects: DefectSet,
): Promise<PhoneTransferEconomics> {
  const tariff = await getTariff(db, client.tariffCode);
  const override = await findDailyLimitOverride(db, client.id);
  const usage = await loadPhoneTransferUsage(db, client.id, now, defects);
  const commissionInput = { amount, monthlyVolumeBefore: usage.usedThisMonthViaSbp, tariff };
  const correctFee = route === 'SBP' ? calculateCommission(commissionInput) : 0n;
  const droppingKopecks = route === 'SBP' && defects.has('commission-rounding');
  return {
    fee: droppingKopecks ? calculateCommissionDroppingKopecks(commissionInput) : correctFee,
    correctFee,
    dailyLimit: effectiveDailyLimit(tariff.dailyPhoneLimit, override),
    usedToday: usage.usedToday,
    usedTodayByMoscowDay: usage.usedTodayByMoscowDay,
  };
}

async function processNewTransfer(tx: Db, deps: TransferDeps, client: Client, input: CreateTransferInput, context: TransferContext): Promise<string> {
  const { defects, repeatOf } = context;
  const { command } = input;
  const now = deps.clock.now();
  const sourceCandidate = await findClientAccountByNumber(tx, client.id, command.fromAccount);
  if (!sourceCandidate) throw unprocessable('ACCOUNT_NOT_FOUND', 'Счёт списания не найден среди ваших счетов');
  const target = await resolveTarget(tx, client, sourceCandidate, command, deps.lookupRecipient);
  const income = await findSystemAccount(tx, 'INCOME');
  const locked = await lockAccounts(tx, [sourceCandidate.id, income.id, ...(target.toAccount ? [target.toAccount.id] : [])]);
  const source = locked.get(sourceCandidate.id) ?? sourceCandidate;

  const economics =
    command.type === 'PHONE_TRANSFER' ? await phoneTransferEconomics(tx, client, target.route, command.amount, now, defects) : NO_ECONOMICS;
  const rejectionFor = (flags: LimitDefectFlags) =>
    evaluateRejection({
      type: command.type,
      route: target.route,
      accountStatus: source.status,
      clientResident: client.resident,
      amount: command.amount,
      dailyLimit: economics.dailyLimit,
      usedToday: flags.utcDay ? economics.usedToday : economics.usedTodayByMoscowDay,
      strictLimit: flags.boundary,
    });
  const limitFlags = { boundary: defects.has('limit-boundary'), utcDay: defects.has('daily-limit-utc') };
  const rejection = rejectionFor(limitFlags);
  const fee = rejection ? 0n : economics.fee;
  const marks: DefectMark[] = [];
  if (command.type === 'PHONE_TRANSFER') {
    marks.push(
      ...limitDefectMarks((flags) => rejectionFor(flags)?.code ?? null, limitFlags, {
        limit: toApiAmount(economics.dailyLimit),
        usedToday: toApiAmount(economics.usedToday),
        usedTodayByMoscowDay: toApiAmount(economics.usedTodayByMoscowDay),
        amount: toApiAmount(command.amount),
      }),
    );
  }
  if (!rejection && fee !== economics.correctFee) {
    marks.push({ code: 'commission-rounding', details: { expected: toApiAmount(economics.correctFee), actual: toApiAmount(fee) } });
  }
  const kafkaInRubles = defects.has('kafka-amount-mismatch');
  if (kafkaInRubles) {
    marks.push({
      code: 'kafka-amount-mismatch',
      details: { topic: getTopics().paymentsCreated, expected: toApiAmount(command.amount), actual: amountInRubles(command.amount) },
    });
  }

  if (!rejection) {
    const held = (await sumActiveHolds(tx, [source.id])).get(source.id) ?? 0n;
    const available = source.balance - held;
    if (available < command.amount + fee) {
      throw unprocessable('INSUFFICIENT_FUNDS', `Недостаточно средств на счёте. Доступно: ${formatRubles(available)}`);
    }
  }

  const created = await insertOperation(tx, {
    clientId: client.id,
    type: command.type,
    route: target.route,
    fromAccountId: source.id,
    toAccountId: target.toAccount?.id ?? null,
    recipientPhone: target.recipientPhone,
    recipientBankCode: target.recipientBankCode,
    recipientName: target.recipientName,
    amount: command.amount,
    fee,
    comment: command.comment,
    attemptLabel: input.attemptLabel,
    requestId: input.requestId,
    createdAt: now,
  });
  if (repeatOf) {
    marks.push({
      code: 'idempotency-double-debit',
      details: {
        expected: repeatOf.number,
        actual: created.number,
        idempotencyKey: input.idempotencyKey,
        firstOperationId: repeatOf.id,
        firstStatus: repeatOf.status,
      },
    });
  } else {
    await insertIdempotencyRecord(tx, client.id, input.idempotencyKey, hashTransferCommand(command), created.id, now);
  }
  await insertDefectMarks(tx, created.id, marks, now);
  await enqueueOutbox(
    tx,
    paymentCreatedMessage({
      operationId: created.id,
      operationNumber: created.number,
      clientNumber: client.number,
      type: command.type,
      route: target.route,
      amount: command.amount,
      fee,
      fromAccount: source.number,
      recipientPhone: target.recipientPhone,
      recipientBankCode: target.recipientBankCode,
      createdAt: now,
      requestId: input.requestId,
      amountInRubles: kafkaInRubles,
    }),
  );
  const stepOptions = (at: Date) => ({ at, requestId: input.requestId });
  await transitionOperation(tx, created.id, 'CHECKING', stepOptions(deps.clock.now()));

  if (rejection) {
    await transitionOperation(tx, created.id, 'REJECTED', {
      ...stepOptions(deps.clock.now()),
      reasonCode: rejection.code,
      comment: rejection.message,
    });
    return created.id;
  }

  await createHold(tx, { accountId: source.id, operationId: created.id, amount: command.amount + fee, at: deps.clock.now() });
  if (command.type === 'OWN_TRANSFER') {
    const operation = await requireLockedOperation(tx, created.id);
    await beginProcessing(tx, { clock: deps.clock, requestId: input.requestId }, operation);
  }
  return created.id;
}

async function findRepeatedOperation(tx: Db, defects: DefectSet, operationId: string): Promise<OperationRecord | null> {
  if (!defects.has('idempotency-double-debit')) return null;
  const first = await findOperationOfAnyClient(tx, operationId);
  return first && !isTerminal(first.status) ? first : null;
}

export async function createTransfer(deps: TransferDeps, input: CreateTransferInput): Promise<CreateTransferResult> {
  return withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, input.clientId);
    const defects = await loadActiveDefects(tx);
    const existing = await findIdempotencyRecord(tx, input.clientId, input.idempotencyKey);
    let repeatOf: OperationRecord | null = null;
    if (existing) {
      if (existing.requestHash !== hashTransferCommand(input.command)) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован с другим телом запроса');
      }
      repeatOf = await findRepeatedOperation(tx, defects, existing.operationId);
      if (!repeatOf) return { operationId: existing.operationId, replayed: true };
    }
    const client = await findClientById(tx, input.clientId);
    if (!client || client.status !== 'ACTIVE') throw forbidden('CLIENT_BLOCKED', 'Операции клиента приостановлены');
    return { operationId: await processNewTransfer(tx, deps, client, input, { defects, repeatOf }), replayed: false };
  });
}
