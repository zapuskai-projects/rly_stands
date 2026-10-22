import { Parser } from '@asyncapi/parser';
import { readWorkText, missingFile } from './work';
import { asRecord } from './http';
import { executor, type ExecutorTable } from './types';

const ERROR_SEVERITY = 0;

type PayloadField = { name: string; type: string };

type SchemaLike = {
  properties?: () => Record<string, SchemaLike> | undefined;
  type?: () => unknown;
  items?: () => SchemaLike | undefined;
};

const FIELD_DEPTH = 4;

function payloadFields(payload: unknown): PayloadField[] {
  const schema = payload as SchemaLike | undefined;
  const properties = schema?.properties?.() ?? {};
  return Object.entries(properties).map(([name, property]) => {
    const type = property.type?.();
    return { name, type: Array.isArray(type) ? type.join('|') : String(type ?? 'any') };
  });
}

export function payloadFieldNames(schema: SchemaLike | undefined, prefix = '', depth = 0): string[] {
  if (!schema || depth > FIELD_DEPTH) return [];
  const names: string[] = [];
  for (const [name, property] of Object.entries(schema.properties?.() ?? {})) {
    const path = `${prefix}${name}`;
    names.push(path);
    const items = property.items?.();
    if (items?.properties?.()) names.push(...payloadFieldNames(items, `${path}[].`, depth + 1));
    else names.push(...payloadFieldNames(property, `${path}.`, depth + 1));
  }
  return names;
}

type KafkaKey = { type: string; description: string; aboutClient: boolean };

type BindingsLike = { get?: (protocol: string) => { value?: () => unknown } | undefined };

export function kafkaKeyOf(bindings: BindingsLike | undefined): KafkaKey | null {
  const value = asRecord(bindings?.get?.('kafka')?.value?.());
  const key = asRecord(value.key);
  if (!Object.keys(key).length) return null;
  const description = typeof key.description === 'string' ? key.description : '';
  const title = typeof key.title === 'string' ? key.title : '';
  return {
    type: typeof key.type === 'string' ? key.type : 'any',
    description,
    aboutClient: /client|клиент/i.test(`${title} ${description} ${JSON.stringify(key.examples ?? '')}`),
  };
}

const failed = (errors: string[]) => ({
  parsed: false,
  errors,
  info: { title: '', version: '' },
  channels: [],
  operations: [],
});

export async function describeAsyncApi(text: string) {
  const parser = new Parser();
  const { document, diagnostics } = await parser.parse(text);
  const errors = diagnostics
    .filter((item) => item.severity === ERROR_SEVERITY)
    .map((item) => `${item.path.length ? `${item.path.join('.')}: ` : ''}${item.message}`);
  if (!document) return failed(errors.length ? errors : ['документ не разобран']);
  const info = document.info();
  return {
    parsed: errors.length === 0,
    errors,
    info: { title: info.title(), version: info.version() },
    channels: document.channels().all().map((channel) => ({
      name: channel.address() ?? channel.id(),
      messages: channel.messages().all().map((message) => ({
        name: message.name() ?? message.id(),
        fields: payloadFields(message.payload()),
        fieldNames: payloadFieldNames(message.payload() as SchemaLike | undefined),
        kafkaKey: kafkaKeyOf(message.bindings() as BindingsLike),
      })),
    })),
    operations: document.operations().all().map((operation) => ({
      id: operation.id(),
      action: operation.action(),
      channel: operation.channels().all()[0]?.address() ?? '',
    })),
  };
}

export const ASYNCAPI_EXECUTORS: ExecutorTable = {
  'asyncapi.describe': executor<{ file: string }>(async ({ file }, ctx) => {
    const text = readWorkText(ctx, file);
    if (text === null) return failed([missingFile(file)]);
    try {
      return await describeAsyncApi(text);
    } catch (error) {
      return failed([asRecord(error).message ? String(asRecord(error).message) : 'документ не разобран']);
    }
  }),
};
