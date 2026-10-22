import path from 'node:path';
import { z } from 'zod';

export const ROOT_DIR = path.resolve(__dirname, '..');
export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');
export const WEB_DIR = path.join(ROOT_DIR, 'web-dist');
export const DOCS_DIR = path.join(ROOT_DIR, 'docs');
export const OPENAPI_PATH = path.join(ROOT_DIR, 'docs', 'openapi.yaml');

export const ROLES = ['core', 'antifraud', 'sbp'] as const;
export type BankRole = (typeof ROLES)[number];

const DEFAULT_PORTS: Record<BankRole, number> = { core: 18400, antifraud: 18401, sbp: 18402 };

const DATABASE_URL_MISSING = 'BANK_DATABASE_URL не задан: банк не запустится без базы данных';

const envSchema = z.object({
  BANK_ROLE: z.enum(ROLES).default('core'),
  BANK_DATABASE_URL: z.string({ error: DATABASE_URL_MISSING }).min(1, DATABASE_URL_MISSING),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  BANK_KAFKA_BROKERS: z.string().min(1).optional(),
  BANK_RABBITMQ_URL: z.string().min(1).optional(),
  KIT_SECRET: z.string().min(1).optional(),
  SBP_URL: z.string().url().optional(),
  SBP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  SBP_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  SBP_MAX_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  TOPIC_PREFIX: z.string().regex(/^[A-Za-z0-9._-]*$/).default(''),
});

export interface Config {
  role: BankRole;
  databaseUrl: string;
  port: number;
  kafkaBrokers: string[];
  rabbitmqUrl: string | null;
  sbpUrl: string | null;
  sbpTimeoutMs: number;
  sbpMinDelayMs: number;
  sbpMaxDelayMs: number;
  topicPrefix: string;
  kitSecret: string | null;
}

const REQUIRED_BY_ROLE: Record<BankRole, { name: string; consequence: string }[]> = {
  core: [
    { name: 'BANK_KAFKA_BROKERS', consequence: 'события платежей некуда отправлять и антифрод не получит переводы' },
    { name: 'BANK_RABBITMQ_URL', consequence: 'уведомления о проведении не дойдут до журнала' },
    { name: 'SBP_URL', consequence: 'переводы в другой банк некому принимать' },
  ],
  antifraud: [{ name: 'BANK_KAFKA_BROKERS', consequence: 'антифрод не получит переводы на оценку' }],
  sbp: [],
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new Error(`Неверная конфигурация банка. ${problems.join('; ')}`);
  }
  const values = parsed.data;
  const missing = REQUIRED_BY_ROLE[values.BANK_ROLE].filter((item) => !env[item.name]);
  if (missing.length > 0) {
    const text = missing.map((item) => `${item.name} не задан: ${item.consequence}`).join('; ');
    throw new Error(`Неверная конфигурация банка (роль ${values.BANK_ROLE}). ${text}`);
  }
  return {
    role: values.BANK_ROLE,
    databaseUrl: values.BANK_DATABASE_URL,
    port: values.PORT ?? DEFAULT_PORTS[values.BANK_ROLE],
    kafkaBrokers: (values.BANK_KAFKA_BROKERS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    rabbitmqUrl: values.BANK_RABBITMQ_URL ?? null,
    sbpUrl: values.SBP_URL ?? null,
    sbpTimeoutMs: values.SBP_TIMEOUT_MS,
    sbpMinDelayMs: values.SBP_MIN_DELAY_MS,
    sbpMaxDelayMs: Math.max(values.SBP_MIN_DELAY_MS, values.SBP_MAX_DELAY_MS),
    topicPrefix: values.TOPIC_PREFIX,
    kitSecret: values.KIT_SECRET ?? null,
  };
}
