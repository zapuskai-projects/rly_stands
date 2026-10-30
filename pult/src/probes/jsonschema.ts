import { loadDocument, type LoadedDocument } from './document';
import { str } from './http';
import { extraPropertiesAllowed, schemaFields, schemaRequired } from './schema-facts';
import { executor, type ExecutorTable } from './types';
import { requiredMissing, samplesFromObservation, type Sample, type SamplesFrom } from './samples-source';
import { createAjv, dialectOf, sampleOutcome, summarize, validateAgainst } from './validators';

export function describeJsonSchema(loaded: LoadedDocument) {
  if (!loaded.ok) {
    return { parsed: false, errors: loaded.errors, $id: '', title: '', type: '', required: [], additionalProperties: null, properties: [] };
  }
  const { doc } = loaded;
  try {
    return {
      parsed: true,
      errors: [],
      $id: str(doc.$id),
      title: str(doc.title),
      type: Array.isArray(doc.type) ? doc.type.join('|') : str(doc.type),
      required: schemaRequired(doc, doc),
      additionalProperties: extraPropertiesAllowed(doc),
      properties: schemaFields(doc, doc),
    };
  } catch (error) {
    return { parsed: false, errors: [(error as Error).message], $id: '', title: '', type: '', required: [], additionalProperties: null, properties: [] };
  }
}

export function checkJsonSchemaSamples(loaded: LoadedDocument, samples: Sample[]) {
  if (!loaded.ok) {
    return withRequired(summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, loaded.errors), ok: false }))), []);
  }
  let required: string[];
  try {
    required = schemaRequired(loaded.doc, loaded.doc);
  } catch (error) {
    const message = (error as Error).message;
    return withRequired(summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, [message]), ok: false }))), []);
  }
  const ajv = createAjv(dialectOf(loaded.doc.$schema));
  let validate;
  try {
    validate = ajv.compile(loaded.doc);
  } catch (error) {
    const message = `схема не разобрана: ${(error as Error).message}`;
    return withRequired(summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, [message]), ok: false }))), []);
  }
  return withRequired(
    summarize(
      samples.map((sample, index) => {
        const outcome = validateAgainst(validate, sample.data);
        return sampleOutcome(index, sample.expectValid, outcome.valid, outcome.errors);
      }),
    ),
    requiredMissing(samples, required),
  );
}

function withRequired(summary: ReturnType<typeof summarize>, missing: string[]) {
  return { ...summary, sampleCount: summary.results.length, requiredMissing: missing };
}

export const JSONSCHEMA_EXECUTORS: ExecutorTable = {
  'jsonschema.describe': executor<{ file: string }>(async ({ file }, ctx) => describeJsonSchema(loadDocument(ctx, file))),

  'jsonschema.samples': executor<{ file: string; samples?: Sample[]; samplesFrom?: SamplesFrom }>(
    async ({ file, samples, samplesFrom }, ctx) => {
      const list = samplesFrom ? samplesFromObservation(ctx.observations, samplesFrom) : (samples ?? []);
      return checkJsonSchemaSamples(loadDocument(ctx, file), list);
    },
  ),
};

