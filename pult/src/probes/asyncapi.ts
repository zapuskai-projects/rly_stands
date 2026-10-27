import { Parser } from '@asyncapi/parser';
import type { ValidateFunction } from 'ajv';
import { readWorkText, missingFile } from './work';
import { asRecord } from './http';
import { executor, type ExecutorTable } from './types';
import { samplesFromObservation, type Sample, type SamplesFrom } from './samples-source';
import { createAjv, sampleOutcome, summarize, validateAgainst } from './validators';

const ERROR_SEVERITY = 0;

type PayloadField = { name: string; type: string; enum: string[] };

type SchemaLike = {
  properties?: () => Record<string, SchemaLike> | undefined;
  type?: () => unknown;
  enum?: () => unknown;
  items?: () => SchemaLike | undefined;
};

const FIELD_DEPTH = 4;

function payloadFields(payload: unknown): PayloadField[] {
  const schema = payload as SchemaLike | undefined;
  const properties = schema?.properties?.() ?? {};
  return Object.entries(properties).map(([name, property]) => {
    const type = property.type?.();
    const values = property.enum?.();
    return {
      name,
      type: Array.isArray(type) ? type.join('|') : String(type ?? 'any'),
      enum: Array.isArray(values) ? values.map(String) : [],
    };
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

type PayloadSchema = { json?: () => unknown };

const unparsed = (samples: Sample[], errors: string[]) => ({
  parsed: false,
  errors,
  sampleCount: samples.length,
  ...summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, errors), ok: false }))),
});

export async function checkAsyncApiSamples(text: string, channel: string | undefined, samples: Sample[]) {
  const parser = new Parser();
  const { document, diagnostics } = await parser.parse(text);
  const errors = diagnostics
    .filter((item) => item.severity === ERROR_SEVERITY)
    .map((item) => `${item.path.length ? `${item.path.join('.')}: ` : ''}${item.message}`);
  if (!document || errors.length) return unparsed(samples, errors.length ? errors : ['документ не разобран']);
  const target = document.channels().all().find((item) => !channel || (item.address() ?? item.id()) === channel);
  const schemas = (target?.messages().all() ?? [])
    .map((message) => (message.payload() as PayloadSchema | undefined)?.json?.())
    .filter((schema): schema is object => Boolean(schema) && typeof schema === 'object');
  if (!schemas.length) {
    return unparsed(samples, [channel ? `у канала ${channel} нет сообщения со схемой тела` : 'в документе нет сообщения со схемой тела']);
  }
  let validators: ValidateFunction[];
  try {
    validators = schemas.map((schema) => createAjv('draft07').compile(schema));
  } catch (error) {
    return unparsed(samples, [`схема тела не разобрана: ${(error as Error).message}`]);
  }
  return {
    parsed: true,
    errors: [],
    sampleCount: samples.length,
    ...summarize(
      samples.map((sample, index) => {
        const outcomes = validators.map((validate) => validateAgainst(validate, sample.data));
        const outcome = outcomes.find((item) => item.valid) ?? (outcomes[0] as (typeof outcomes)[number]);
        return sampleOutcome(index, sample.expectValid, outcome.valid, outcome.errors);
      }),
    ),
  };
}

export const ASYNCAPI_EXECUTORS: ExecutorTable = {
  'asyncapi.describe': executor<{ file: string }>(async ({ file }, ctx) => {
    const text = readWorkText(ctx, file);
    if (text === null) return failed([missingFile(file, ctx)]);
    try {
      return await describeAsyncApi(text);
    } catch (error) {
      return failed([asRecord(error).message ? String(asRecord(error).message) : 'документ не разобран']);
    }
  }),

  'asyncapi.samples': executor<{ file: string; channel?: string; samplesFrom: SamplesFrom }>(async ({ file, channel, samplesFrom }, ctx) => {
    const samples = samplesFromObservation(ctx.observations, samplesFrom);
    const text = readWorkText(ctx, file);
    if (text === null) return unparsed(samples, [missingFile(file, ctx)]);
    try {
      return await checkAsyncApiSamples(text, channel, samples);
    } catch (error) {
      return unparsed(samples, [asRecord(error).message ? String(asRecord(error).message) : 'документ не разобран']);
    }
  }),
};
