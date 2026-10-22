import { loadDocument, type LoadedDocument } from './document';
import { asArray, str } from './http';
import { extraPropertiesAllowed, schemaFields } from './schema-facts';
import { executor, type ExecutorTable } from './types';
import { createAjv, dialectOf, sampleOutcome, summarize, validateAgainst } from './validators';

type Sample = { data: unknown; expectValid: boolean };

export function describeJsonSchema(loaded: LoadedDocument) {
  if (!loaded.ok) {
    return { parsed: false, errors: loaded.errors, $id: '', title: '', type: '', required: [], additionalProperties: null, properties: [] };
  }
  const { doc } = loaded;
  return {
    parsed: true,
    errors: [],
    $id: str(doc.$id),
    title: str(doc.title),
    type: Array.isArray(doc.type) ? doc.type.join('|') : str(doc.type),
    required: asArray(doc.required).map(String),
    additionalProperties: extraPropertiesAllowed(doc),
    properties: schemaFields(doc, doc),
  };
}

export function checkJsonSchemaSamples(loaded: LoadedDocument, samples: Sample[]) {
  if (!loaded.ok) {
    return summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, loaded.errors), ok: false })));
  }
  const ajv = createAjv(dialectOf(loaded.doc.$schema));
  let validate;
  try {
    validate = ajv.compile(loaded.doc);
  } catch (error) {
    const message = `схема не разобрана: ${(error as Error).message}`;
    return summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, [message]), ok: false })));
  }
  return summarize(
    samples.map((sample, index) => {
      const outcome = validateAgainst(validate, sample.data);
      return sampleOutcome(index, sample.expectValid, outcome.valid, outcome.errors);
    }),
  );
}

export const JSONSCHEMA_EXECUTORS: ExecutorTable = {
  'jsonschema.describe': executor<{ file: string }>(async ({ file }, ctx) => describeJsonSchema(loadDocument(ctx, file))),

  'jsonschema.samples': executor<{ file: string; samples: Sample[] }>(async ({ file, samples }, ctx) =>
    checkJsonSchemaSamples(loadDocument(ctx, file), samples),
  ),
};

