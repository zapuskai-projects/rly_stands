import type { Pool } from 'pg';
import { findClientAccountById, findClientAccountByNumber, type Account } from '../accounts/accounts.repository';
import { toApiAmount, type Kopecks } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { lockClientForTransfers } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import type { DefectMark } from '../defects/catalog';
import { loadActiveDefects } from '../defects/defects.repository';
import { findClientOperation } from '../payments/operations.repository';
import { createTransfer, type CreateTransferResult } from '../payments/transfer.service';
import type { RecipientNameLookup } from '../sbp/gateway';
import { BANK } from '../shared/bank-identity';
import { badRequest, conflict, notFound, unprocessable } from '../shared/errors';
import {
  MAX_TEMPLATES_PER_CLIENT,
  kindOfOperation,
  normalizeTemplateName,
  resolveAmount,
  templateCommand,
  templateNameIssue,
  type TemplateKind,
  type TemplateRecord,
} from './template-rules';
import {
  countClientTemplates,
  findClientTemplate,
  hasOpenAutopayments,
  insertTemplate,
  isTemplateNameTaken,
  softDeleteTemplate,
  updateTemplate,
  type NewTemplate,
} from './templates.repository';

export interface TemplateDeps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient?: RecipientNameLookup;
}

export interface CreateTemplateInput {
  name: string;
  fromOperationId?: string;
  kind?: TemplateKind;
  fromAccount?: string;
  toAccount?: string;
  recipientPhone?: string;
  recipientBankCode?: string;
  amount?: Kopecks;
  comment?: string | null;
}

type ManualTemplateInput = CreateTemplateInput & { kind: TemplateKind; fromAccount: string };

export interface TemplatePatchInput {
  name?: string;
  fromAccount?: string;
  amount?: Kopecks | null;
  comment?: string | null;
}

function invalid(field: string, message: string): never {
  throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: `body.${field}`, message }]);
}

function checkedName(raw: string): string {
  const name = normalizeTemplateName(raw);
  const issue = templateNameIssue(name);
  if (issue) invalid('name', issue);
  return name;
}

async function requireOwnAccount(db: Db, clientId: string, number: string, message: string): Promise<Account> {
  const account = await findClientAccountByNumber(db, clientId, number);
  if (!account) throw unprocessable('ACCOUNT_NOT_FOUND', message);
  return account;
}

async function assertPartnerBank(db: Db, code: string): Promise<void> {
  const found = await db.query('SELECT 1 FROM partner_banks WHERE code = $1 AND active', [code]);
  if ((found.rowCount ?? 0) === 0) throw unprocessable('UNKNOWN_BANK', 'Банк получателя не найден в справочнике банков');
}

async function manualTemplate(tx: Db, clientId: string, input: ManualTemplateInput, name: string, at: Date): Promise<NewTemplate> {
  const from = await requireOwnAccount(tx, clientId, input.fromAccount, 'Счёт списания не найден среди ваших счетов');
  const base = { clientId, name, kind: input.kind, fromAccountId: from.id, amount: input.amount ?? null, comment: input.comment ?? null, at };
  if (input.kind === 'OWN') {
    if (!input.toAccount) invalid('toAccount', 'Для шаблона между своими счетами нужен счёт зачисления');
    if (input.recipientPhone !== undefined) invalid('recipientPhone', 'Телефон не указывается для перевода между своими счетами');
    if (input.recipientBankCode !== undefined) invalid('recipientBankCode', 'Банк не указывается для перевода между своими счетами');
    const to = await requireOwnAccount(tx, clientId, input.toAccount as string, 'Счёт зачисления не найден среди ваших счетов');
    if (to.id === from.id) throw unprocessable('SAME_ACCOUNT', 'Счета списания и зачисления совпадают');
    return { ...base, toAccountId: to.id, recipientPhone: null, recipientBankCode: null };
  }
  if (input.toAccount !== undefined) invalid('toAccount', 'Счёт зачисления указывается только для перевода между своими счетами');
  if (!input.recipientPhone) invalid('recipientPhone', 'Укажите телефон получателя');
  if (input.kind === 'PHONE') {
    if (input.recipientBankCode !== undefined && input.recipientBankCode !== BANK.code) invalid('recipientBankCode', `Для перевода внутри банка код банка — ${BANK.code}`);
    return { ...base, toAccountId: null, recipientPhone: input.recipientPhone as string, recipientBankCode: BANK.code };
  }
  if (!input.recipientBankCode || input.recipientBankCode === BANK.code) invalid('recipientBankCode', 'Для перевода через СБП укажите банк получателя из справочника банков');
  await assertPartnerBank(tx, input.recipientBankCode as string);
  return { ...base, toAccountId: null, recipientPhone: input.recipientPhone as string, recipientBankCode: input.recipientBankCode as string };
}

async function templateFromOperation(tx: Db, clientId: string, operationId: string, name: string, at: Date): Promise<NewTemplate> {
  const operation = await findClientOperation(tx, clientId, operationId);
  if (!operation) throw notFound('OPERATION_NOT_FOUND', 'Операция не найдена');
  if (operation.status !== 'COMPLETED') throw unprocessable('OPERATION_NOT_COMPLETED', 'Шаблон можно создать только из выполненной операции');
  const from = await findClientAccountById(tx, clientId, operation.fromAccountId);
  if (!from) throw unprocessable('ACCOUNT_NOT_FOUND', 'Счёт списания не найден среди ваших счетов');
  const kind = kindOfOperation(operation);
  return {
    clientId,
    name,
    kind,
    fromAccountId: from.id,
    toAccountId: kind === 'OWN' ? operation.toAccountId : null,
    recipientPhone: kind === 'OWN' ? null : operation.recipientPhone,
    recipientBankCode: kind === 'OWN' ? null : operation.recipientBankCode,
    amount: operation.amount,
    comment: operation.comment,
    at,
  };
}

function checkedShape(input: CreateTemplateInput): void {
  if (input.fromOperationId !== undefined) {
    const extra = (['kind', 'fromAccount', 'toAccount', 'recipientPhone', 'recipientBankCode', 'amount', 'comment'] as const).find((field) => input[field] !== undefined);
    if (extra) invalid(extra, 'При создании из операции передаются только название и операция');
    return;
  }
  if (input.kind === undefined) invalid('kind', 'Укажите fromOperationId или вид шаблона');
  if (input.fromAccount === undefined) invalid('fromAccount', 'Укажите счёт списания');
}

export async function createTemplate(deps: TemplateDeps, clientId: string, input: CreateTemplateInput): Promise<TemplateRecord> {
  const name = checkedName(input.name);
  checkedShape(input);
  return withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, clientId);
    const at = deps.clock.now();
    const draft =
      input.fromOperationId !== undefined
        ? await templateFromOperation(tx, clientId, input.fromOperationId, name, at)
        : await manualTemplate(tx, clientId, input as ManualTemplateInput, name, at);
    if ((await countClientTemplates(tx, clientId)) >= MAX_TEMPLATES_PER_CLIENT) {
      throw unprocessable('TEMPLATE_LIMIT_REACHED', `Можно сохранить не больше ${MAX_TEMPLATES_PER_CLIENT} шаблонов`);
    }
    if (await isTemplateNameTaken(tx, clientId, name, null)) throw conflict('TEMPLATE_NAME_TAKEN', 'Шаблон с таким названием уже есть');
    const id = await insertTemplate(tx, draft);
    return (await findClientTemplate(tx, clientId, id)) as TemplateRecord;
  });
}

export async function changeTemplate(deps: TemplateDeps, clientId: string, templateId: string, patch: TemplatePatchInput): Promise<TemplateRecord> {
  const name = patch.name === undefined ? undefined : checkedName(patch.name);
  return withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, clientId);
    const current = await findClientTemplate(tx, clientId, templateId);
    if (!current) throw notFound('TEMPLATE_NOT_FOUND', 'Шаблон не найден');
    const from = patch.fromAccount === undefined ? null : await requireOwnAccount(tx, clientId, patch.fromAccount, 'Счёт списания не найден среди ваших счетов');
    if (from && current.kind === 'OWN' && from.id === current.toAccountId) throw unprocessable('SAME_ACCOUNT', 'Счета списания и зачисления совпадают');
    if (name !== undefined && (await isTemplateNameTaken(tx, clientId, name, templateId))) throw conflict('TEMPLATE_NAME_TAKEN', 'Шаблон с таким названием уже есть');
    await updateTemplate(tx, templateId, { name, fromAccountId: from?.id, amount: patch.amount, comment: patch.comment }, deps.clock.now());
    return (await findClientTemplate(tx, clientId, templateId)) as TemplateRecord;
  });
}

export async function removeTemplate(deps: TemplateDeps, clientId: string, templateId: string): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, clientId);
    if (!(await findClientTemplate(tx, clientId, templateId))) throw notFound('TEMPLATE_NOT_FOUND', 'Шаблон не найден');
    if (await hasOpenAutopayments(tx, templateId)) throw conflict('TEMPLATE_IN_USE', 'По шаблону есть действующие автоплатежи: отмените их, чтобы удалить шаблон');
    await softDeleteTemplate(tx, templateId, deps.clock.now());
  });
}

export interface TemplateTransferInput {
  clientId: string;
  templateId: string;
  idempotencyKey: string;
  amount?: Kopecks;
  comment?: string | null;
  requestId: string;
  attemptLabel: string | null;
}

export async function transferByTemplate(deps: TemplateDeps, input: TemplateTransferInput): Promise<CreateTransferResult> {
  const template = await findClientTemplate(deps.pool, input.clientId, input.templateId);
  if (!template) throw notFound('TEMPLATE_NOT_FOUND', 'Шаблон не найден');
  let amount = resolveAmount(template.amount, input.amount);
  if (amount === null) throw unprocessable('AMOUNT_REQUIRED', 'У шаблона нет суммы: укажите её в запросе');
  const defectMarks: DefectMark[] = [];
  if (input.amount !== undefined && template.amount !== null && input.amount !== template.amount && (await loadActiveDefects(deps.pool)).has('template-ignores-amount')) {
    defectMarks.push({ code: 'template-ignores-amount', details: { expected: toApiAmount(input.amount), actual: toApiAmount(template.amount), templateId: template.id } });
    amount = template.amount;
  }
  return createTransfer(deps, {
    clientId: input.clientId,
    idempotencyKey: input.idempotencyKey,
    command: templateCommand(template, amount, input.comment ?? template.comment),
    templateId: template.id,
    defectMarks,
    requestId: input.requestId,
    attemptLabel: input.attemptLabel,
  });
}
