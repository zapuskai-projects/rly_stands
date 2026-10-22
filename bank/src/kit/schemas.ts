import { z } from 'zod';
import { isDefectCode, type DefectCode } from '../defects/catalog';
import { OPERATION_STATUSES } from '../payments/status';
import { badRequest } from '../shared/errors';

const LABEL = /^[A-Za-z0-9._:-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;
const PHONE = /^\+79[0-9]{9}$/;
const MAX_CHECK_BALANCE_KOP = 10_000_000_000;
const MOSCOW_OFFSET = '+03:00';
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

const kopecks = z.int().min(0);
const label = z.string().regex(LABEL, 'метка: 1–64 символа, латиница, цифры и . _ : -');
const phone = z.string().regex(PHONE, 'телефон в формате +79XXXXXXXXX');

const tariffPatch = z
  .object({
    code: z.string().min(1),
    dailyLimitKop: kopecks.optional(),
    freeMonthlyKop: kopecks.optional(),
    rateBps: z.int().min(0).max(10_000).optional(),
    minKop: kopecks.optional(),
    maxKop: kopecks.optional(),
  })
  .strict();

const personaPatch = z
  .object({
    phone,
    tariffCode: z.enum(['START', 'PENSION']).optional(),
    dailyLimitKop: kopecks.nullable().optional(),
    accountStatus: z.enum(['ACTIVE', 'ARRESTED']).optional(),
  })
  .strict();

const bankTime = z
  .string()
  .regex(ISO_MOMENT, 'время в формате ISO 8601, без смещения считается московским')
  .nullable()
  .transform((value, context) => {
    if (value === null) return null;
    const instant = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}${MOSCOW_OFFSET}`);
    if (Number.isNaN(instant.getTime())) {
      context.addIssue({ code: 'custom', message: 'такого момента не существует' });
      return z.NEVER;
    }
    return instant;
  });

const defects = z.array(z.string()).transform((codes, context) => {
  for (const [index, code] of codes.entries()) {
    if (!isDefectCode(code)) context.addIssue({ code: 'custom', path: [index], message: `неизвестный код: ${code}` });
  }
  return codes as DefectCode[];
});

const scenario = z
  .object({
    label,
    defects,
    sbpMode: z.enum(['NORMAL', 'REJECT', 'TIMEOUT', 'UNAVAILABLE']),
    bankTime,
    tariffs: z.array(tariffPatch).optional(),
    personas: z.array(personaPatch).optional(),
  })
  .strict();

const transferAction = z
  .object({
    phone,
    fromAccount: z.string().regex(/^[0-9]{20}$/, 'номер счёта из 20 цифр').optional(),
    toPhone: phone.optional(),
    toBankCode: z.string().min(1).max(32).optional(),
    toOwnAccount: z.string().regex(/^[0-9]{20}$/, 'номер счёта из 20 цифр').optional(),
    amountKop: z.int().min(1),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY, 'ключ повтора: 8–64 символа, латиница, цифры и . _ : -'),
    label,
  })
  .strict()
  .refine((value) => (value.toPhone === undefined) !== (value.toOwnAccount === undefined), {
    message: 'нужен ровно один получатель: toPhone или toOwnAccount',
    path: ['toPhone'],
  });

const checkClientAction = z
  .object({
    tariffCode: z.string().regex(/^[A-Z0-9_]{2,20}$/, 'код тарифа: заглавные латинские буквы, цифры и _'),
    balanceKop: z.int().min(0).max(MAX_CHECK_BALANCE_KOP),
  })
  .strict();

const reviewAction = z
  .object({
    operationId: z.uuid(),
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: z.string().min(1).max(500).optional(),
  })
  .strict();

const operationsQuery = z
  .object({
    label: label.optional(),
    phone: phone.optional(),
    status: z.enum(OPERATION_STATUSES).optional(),
  })
  .strict();

const requestsQuery = z.object({ label }).strict();
const ledgerQuery = z.object({ account: z.string().regex(/^[0-9]{20}$/, 'номер счёта из 20 цифр').optional() }).strict();

export type TariffPatchInput = z.infer<typeof tariffPatch>;
export type PersonaPatchInput = z.infer<typeof personaPatch>;
export type ScenarioInput = z.infer<typeof scenario>;
export type TransferActionInput = z.infer<typeof transferAction>;
export type CheckClientActionInput = z.infer<typeof checkClientAction>;
export type ReviewActionInput = z.infer<typeof reviewAction>;

export function parseKit<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw ?? {});
  if (result.success) return result.data;
  throw badRequest(
    'VALIDATION_ERROR',
    'Запрос не прошёл проверку формата',
    result.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
  );
}

export const kitSchemas = { scenario, tariffPatch, transferAction, checkClientAction, reviewAction, operationsQuery, requestsQuery, ledgerQuery };
