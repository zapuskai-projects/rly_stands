import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ROOT_DIR } from '../config';
import { DEFAULT_RELEASE, type Release } from '../release/release';
import { specForRelease } from '../release/spec-filter';

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

type MessageDefinition = { payload: Json; headers: Json };

export function loadAsyncApi(release: Release = DEFAULT_RELEASE): AsyncApiContract {
  const document = parse(specForRelease(readFileSync(path.join(ROOT_DIR, 'docs', 'asyncapi.yaml'), 'utf8'), release)) as Json;
  const channels = document.channels as Record<string, { subscribe: { message: { $ref?: string; oneOf?: { $ref: string }[] } } }>;
  const components = document.components as { messages: Record<string, MessageDefinition>; schemas: Json };
  const defs = rewrite(components.schemas) as Json;
  const messagesOf = (channel: string): MessageDefinition[] => {
    const message = (channels[channel] as { subscribe: { message: { $ref?: string; oneOf?: { $ref: string }[] } } }).subscribe.message;
    const refs = message.oneOf ?? [{ $ref: message.$ref as string }];
    return refs.map((ref) => components.messages[ref.$ref.split('/').pop() as string] as MessageDefinition);
  };
  return {
    channels: Object.keys(channels),
    payloadValidator(channel) {
      const schemas = messagesOf(channel).map((message) => z.fromJSONSchema({ ...(rewrite(message.payload) as Json), $defs: defs } as z.core.JSONSchema.JSONSchema));
      return (value) => {
        const results = schemas.map((schema) => schema.safeParse(value));
        if (results.some((result) => result.success)) return { ok: true, issues: [] };
        const failed = results[0];
        return { ok: false, issues: failed && !failed.success ? failed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) : [] };
      };
    },
    messageHeaders(channel) {
      const headers = (messagesOf(channel)[0] as MessageDefinition).headers;
      const headersSchema = (defs[(headers.$ref as string).split('/').pop() as string] ?? {}) as { properties?: Json };
      return Object.keys(headersSchema.properties ?? {});
    },
  };
}
