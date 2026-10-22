import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ROOT_DIR } from '../config';

type Json = Record<string, unknown>;

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (typeof node !== 'object' || node === null) return node;
  const result: Json = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = key === '$ref' && typeof value === 'string' ? value.replace('#/components/schemas/', '#/$defs/') : rewrite(value);
  }
  return result;
}

export interface AsyncApiContract {
  channels: string[];
  payloadValidator(channel: string): (value: unknown) => { ok: boolean; issues: string[] };
  messageHeaders(channel: string): string[];
}

export function loadAsyncApi(): AsyncApiContract {
  const document = parse(readFileSync(path.join(ROOT_DIR, 'docs', 'asyncapi.yaml'), 'utf8')) as Json;
  const channels = document.channels as Record<string, { subscribe: { message: { $ref: string } } }>;
  const components = document.components as { messages: Record<string, { payload: Json; headers: Json }>; schemas: Json };
  const defs = rewrite(components.schemas) as Json;
  const messageOf = (channel: string) => components.messages[(channels[channel] as { subscribe: { message: { $ref: string } } }).subscribe.message.$ref.split('/').pop() as string] as { payload: Json; headers: Json };
  return {
    channels: Object.keys(channels),
    payloadValidator(channel) {
      const schema = z.fromJSONSchema({ ...(rewrite(messageOf(channel).payload) as Json), $defs: defs } as z.core.JSONSchema.JSONSchema);
      return (value) => {
        const parsed = schema.safeParse(value);
        return parsed.success ? { ok: true, issues: [] } : { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
      };
    },
    messageHeaders(channel) {
      const headersSchema = (defs[(messageOf(channel).headers.$ref as string).split('/').pop() as string] ?? {}) as { properties?: Json };
      return Object.keys(headersSchema.properties ?? {});
    },
  };
}
