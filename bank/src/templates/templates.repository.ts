import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import { BANK } from '../shared/bank-identity';
import type { TemplateKind, TemplateRecord } from './template-rules';

interface TemplateRow {
  id: string;
  client_id: string;
  name: string;
  kind: TemplateKind;
  from_account_id: string;
  from_account_number: string;
  to_account_id: string | null;
  to_account_number: string | null;
  recipient_phone: string | null;
  recipient_bank_code: string | null;
  recipient_bank_name: string | null;
  amount_kop: bigint | null;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const SELECT_VIEW = `
  SELECT t.id, t.client_id, t.name, t.kind, t.from_account_id, fa.number AS from_account_number, t.to_account_id,
         ta.number AS to_account_number, t.recipient_phone, t.recipient_bank_code, pb.name AS recipient_bank_name,
         t.amount_kop, t.comment, t.created_at, t.updated_at, t.deleted_at
  FROM transfer_templates t
  JOIN accounts fa ON fa.id = t.from_account_id
  LEFT JOIN accounts ta ON ta.id = t.to_account_id
  LEFT JOIN partner_banks pb ON pb.code = t.recipient_bank_code`;

function mapTemplate(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    kind: row.kind,
    fromAccountId: row.from_account_id,
    fromAccountNumber: row.from_account_number,
    toAccountId: row.to_account_id,
    toAccountNumber: row.to_account_number,
    recipientPhone: row.recipient_phone,
    recipientBankCode: row.recipient_bank_code,
    recipientBankName: row.recipient_bank_code === BANK.code ? BANK.name : row.recipient_bank_name,
    amount: row.amount_kop,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export async function listClientTemplates(db: Db, clientId: string): Promise<TemplateRecord[]> {
  const result = await db.query<TemplateRow>(`${SELECT_VIEW} WHERE t.client_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at, t.name`, [clientId]);
  return result.rows.map(mapTemplate);
}

export async function findClientTemplate(db: Db, clientId: string, templateId: string): Promise<TemplateRecord | null> {
  const result = await db.query<TemplateRow>(`${SELECT_VIEW} WHERE t.client_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`, [clientId, templateId]);
  const row = result.rows[0];
  return row ? mapTemplate(row) : null;
}

export async function findTemplateOfAnyClient(db: Db, templateId: string): Promise<TemplateRecord | null> {
  const result = await db.query<TemplateRow>(`${SELECT_VIEW} WHERE t.id = $1`, [templateId]);
  const row = result.rows[0];
  return row ? mapTemplate(row) : null;
}

export async function countClientTemplates(db: Db, clientId: string): Promise<number> {
  const result = await db.query<{ total: bigint }>('SELECT COUNT(*) AS total FROM transfer_templates WHERE client_id = $1 AND deleted_at IS NULL', [clientId]);
  return Number((result.rows[0] as { total: bigint }).total);
}

export async function isTemplateNameTaken(db: Db, clientId: string, name: string, exceptId: string | null): Promise<boolean> {
  const result = await db.query(
    'SELECT 1 FROM transfer_templates WHERE client_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)',
    [clientId, name, exceptId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface NewTemplate {
  clientId: string;
  name: string;
  kind: TemplateKind;
  fromAccountId: string;
  toAccountId: string | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  amount: Kopecks | null;
  comment: string | null;
  at: Date;
}

export async function insertTemplate(db: Db, input: NewTemplate): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO transfer_templates (client_id, name, kind, from_account_id, to_account_id, recipient_phone, recipient_bank_code, amount_kop, comment, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [input.clientId, input.name, input.kind, input.fromAccountId, input.toAccountId, input.recipientPhone, input.recipientBankCode, input.amount, input.comment, input.at],
  );
  return (result.rows[0] as { id: string }).id;
}

export interface TemplatePatch {
  name?: string;
  fromAccountId?: string;
  amount?: Kopecks | null;
  comment?: string | null;
}

export async function updateTemplate(db: Db, templateId: string, patch: TemplatePatch, at: Date): Promise<void> {
  await db.query(
    `UPDATE transfer_templates SET
       name = COALESCE($2, name),
       from_account_id = COALESCE($3, from_account_id),
       amount_kop = CASE WHEN $4::boolean THEN $5 ELSE amount_kop END,
       comment = CASE WHEN $6::boolean THEN $7 ELSE comment END,
       updated_at = $8
     WHERE id = $1`,
    [
      templateId,
      patch.name ?? null,
      patch.fromAccountId ?? null,
      patch.amount !== undefined,
      patch.amount ?? null,
      patch.comment !== undefined,
      patch.comment ?? null,
      at,
    ],
  );
}

export async function softDeleteTemplate(db: Db, templateId: string, at: Date): Promise<void> {
  await db.query('UPDATE transfer_templates SET deleted_at = $2, updated_at = $2 WHERE id = $1', [templateId, at]);
}

export async function hasOpenAutopayments(db: Db, templateId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM autopayments WHERE template_id = $1 AND status <> 'FINISHED' LIMIT 1", [templateId]);
  return (result.rowCount ?? 0) > 0;
}
