import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../docker/exec';
import { loadDocument, resolveRef, type LoadedDocument } from './document';
import { ProbeError } from './errors';
import { asArray, asRecord, num, str } from './http';
import { schemaFields, schemaSummary, schemaTypeName } from './schema-facts';
import { executor, type ExecutorTable } from './types';
import { createAjv, sampleOutcome, summarize, validateAgainst, type SampleResult } from './validators';
import { missingFile, workPath, workSize } from './work';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const REDOCLY_CLI = require.resolve('@redocly/cli/bin/cli.js');
const LINT_CONFIG = 'extends:\n  - minimal\n';
const LINT_TIMEOUT_MS = 60_000;

type SampleInput = {
  path: string;
  method: string;
  part: 'request' | 'response';
  status?: string;
  body: unknown;
  expectValid: boolean;
};

function isOpenApi(doc: Record<string, unknown>): boolean {
  return typeof doc.openapi === 'string';
}

function failedLoad(loaded: Extract<LoadedDocument, { ok: false }>) {
  return {
    parsed: false,
    errors: loaded.errors,
    info: { title: '', version: '' },
    methods: [],
    schemas: [],
  };
}

function bodySchema(doc: Record<string, unknown>, container: unknown) {
  const content = asRecord(asRecord(resolveRef(doc, container)).content);
  const media = pickContent(content);
  const schema = media ? asRecord(content[media]).schema : undefined;
  return schema === undefined ? null : schemaSummary(doc, schema);
}

function describeRequestBody(doc: Record<string, unknown>, node: unknown) {
  if (node === undefined) return null;
  const body = asRecord(resolveRef(doc, node));
  return { required: body.required === true, schema: bodySchema(doc, body) };
}

function describeResponseBodies(doc: Record<string, unknown>, responses: unknown) {
  return Object.entries(asRecord(responses)).map(([status, response]) => ({
    status,
    schema: bodySchema(doc, response),
  }));
}

function describeMethods(doc: Record<string, unknown>) {
  const methods: Array<Record<string, unknown>> = [];
  for (const [path, item] of Object.entries(asRecord(doc.paths))) {
    const pathItem = asRecord(resolveRef(doc, item));
    for (const method of HTTP_METHODS) {
      const operation = asRecord(resolveRef(doc, pathItem[method]));
      if (!Object.keys(operation).length) continue;
      const parameters = [...asArray(pathItem.parameters), ...asArray(operation.parameters)]
        .map((parameter) => asRecord(resolveRef(doc, parameter)))
        .map((parameter) => ({
          name: str(parameter.name),
          in: str(parameter.in),
          required: parameter.required === true,
        }));
      methods.push({
        path,
        method,
        operationId: typeof operation.operationId === 'string' ? operation.operationId : null,
        parameters,
        responses: Object.keys(asRecord(operation.responses)),
        requestBody: describeRequestBody(doc, operation.requestBody),
        responseBodies: describeResponseBodies(doc, operation.responses),
      });
    }
  }
  return methods;
}

function describeSchemas(doc: Record<string, unknown>) {
  const schemas = asRecord(asRecord(doc.components).schemas);
  return Object.entries(schemas).map(([name, schema]) => ({
    name,
    type: schemaTypeName(doc, schema),
    fields: schemaFields(doc, schema),
  }));
}

export function describeOpenApi(loaded: LoadedDocument) {
  if (!loaded.ok) return failedLoad(loaded);
  const { doc } = loaded;
  if (!isOpenApi(doc)) {
    return { ...failedLoad({ ok: false, errors: ['нет поля openapi — это не OpenAPI 3-файл'] }) };
  }
  const info = asRecord(doc.info);
  return {
    parsed: true,
    errors: [],
    info: { title: str(info.title), version: str(info.version) },
    methods: describeMethods(doc),
    schemas: describeSchemas(doc),
  };
}

function pointerOf(...segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment.replace(/~/g, '~0').replace(/\//g, '~1'))).join('/');
}

function pickContent(content: unknown): string | null {
  const keys = Object.keys(asRecord(content));
  return keys.find((key) => key === 'application/json') ?? keys.find((key) => key.includes('json')) ?? keys[0] ?? null;
}

function schemaPointer(doc: Record<string, unknown>, sample: SampleInput): string | null {
  const pathItem = asRecord(resolveRef(doc, asRecord(doc.paths)[sample.path]));
  const method = sample.method.toLowerCase();
  const operation = asRecord(resolveRef(doc, pathItem[method]));
  if (!Object.keys(operation).length) return null;
  const base = ['paths', sample.path, method];
  if (sample.part === 'request') {
    const body = asRecord(resolveRef(doc, operation.requestBody));
    const media = pickContent(body.content);
    return media && asRecord(asRecord(body.content)[media]).schema
      ? `#/${pointerOf(...base, 'requestBody', 'content', media, 'schema')}`
      : null;
  }
  const responses = asRecord(operation.responses);
  const status = sample.status ?? Object.keys(responses).find((code) => code.startsWith('2')) ?? Object.keys(responses)[0];
  if (!status) return null;
  const response = asRecord(resolveRef(doc, responses[status]));
  const media = pickContent(response.content);
  return media && asRecord(asRecord(response.content)[media]).schema
    ? `#/${pointerOf(...base, 'responses', status, 'content', media, 'schema')}`
    : null;
}

export function checkOpenApiSamples(loaded: LoadedDocument, samples: SampleInput[]) {
  if (!loaded.ok || !isOpenApi(loaded.doc)) {
    const errors = loaded.ok ? ['нет поля openapi — это не OpenAPI 3-файл'] : loaded.errors;
    return summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, errors), ok: false })));
  }
  const { doc } = loaded;
  const ajv = createAjv(String(doc.openapi).startsWith('3.1') ? '2020' : 'draft07');
  ajv.addSchema(doc, 'urn:kit:openapi');
  const results: SampleResult[] = samples.map((sample, index) => {
    const pointer = schemaPointer(doc, sample);
    if (!pointer) {
      const where = sample.part === 'request' ? 'тела запроса' : 'тела ответа';
      return { ...sampleOutcome(index, sample.expectValid, false, [`в контракте нет схемы ${where} для ${sample.method.toUpperCase()} ${sample.path}`]), ok: false };
    }
    try {
      const outcome = validateAgainst(ajv.compile({ $ref: `urn:kit:openapi${pointer}` }), sample.body);
      return sampleOutcome(index, sample.expectValid, outcome.valid, outcome.errors);
    } catch (error) {
      return { ...sampleOutcome(index, sample.expectValid, false, [`схема не разобрана: ${(error as Error).message}`]), ok: false };
    }
  });
  return summarize(results);
}

function jsonFrom(output: string): Record<string, unknown> | null {
  const start = output.indexOf('{');
  if (start < 0) return null;
  try {
    return asRecord(JSON.parse(output.slice(start)));
  } catch {
    return null;
  }
}

async function lintFile(absolute: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-lint-'));
  try {
    const config = join(dir, 'redocly.yaml');
    writeFileSync(config, LINT_CONFIG);
    const result = await run(process.execPath, [REDOCLY_CLI, 'lint', absolute, '--config', config, '--format=json'], {
      timeoutMs: LINT_TIMEOUT_MS,
    });
    const report = jsonFrom(result.stdout);
    if (!report) throw new ProbeError(`Redocly не вернул отчёт: ${(result.stderr || result.stdout).slice(0, 200).trim()}`);
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function lintOpenApi(absolute: string) {
  const report = await lintFile(absolute);
  const problems = asArray(report.problems).map((item) => {
    const row = asRecord(item);
    const location = asRecord(asArray(row.location)[0]);
    return {
      severity: str(row.severity) === 'error' ? 'error' : 'warn',
      rule: str(row.ruleId),
      message: str(row.message),
      location: str(location.pointer),
    };
  });
  return {
    errors: problems.filter((item) => item.severity === 'error').length,
    warnings: problems.filter((item) => item.severity === 'warn').length,
    problems,
  };
}

async function breaking(base: string, revision: string) {
  const result = await run('oasdiff', ['breaking', base, revision, '--format', 'json'], { timeoutMs: LINT_TIMEOUT_MS });
  if (result.code !== 0 && !result.stdout.trim().startsWith('[')) {
    const reason = (result.stderr || result.stdout).trim().split('\n')[0] ?? 'oasdiff завершился с ошибкой';
    if (/no such file|executable file not found|ENOENT/i.test(reason)) throw new ProbeError('Проверка ломающих изменений недоступна: в образе пульта нет oasdiff');
    return { count: 0, breaking: [], error: reason.slice(0, 300) };
  }
  let changes: unknown[] = [];
  try {
    changes = asArray(JSON.parse(result.stdout.trim() || '[]'));
  } catch {
    changes = [];
  }
  const list = changes.map((item) => {
    const row = asRecord(item);
    return { id: str(row.id), text: str(row.text), level: num(row.level) };
  });
  return { count: list.length, breaking: list, error: null };
}

export const OPENAPI_EXECUTORS: ExecutorTable = {
  'openapi.describe': executor<{ file: string }>(async ({ file }, ctx) => describeOpenApi(loadDocument(ctx, file))),

  'openapi.lint': executor<{ file: string }>(async ({ file }, ctx) => {
    if (workSize(ctx, file) === null) {
      return { errors: 1, warnings: 0, problems: [{ severity: 'error', rule: 'file', message: missingFile(file), location: '' }] };
    }
    return lintOpenApi(workPath(ctx, file));
  }),

  'openapi.samples': executor<{ file: string; samples: SampleInput[] }>(async ({ file, samples }, ctx) =>
    checkOpenApiSamples(loadDocument(ctx, file), samples),
  ),

  'openapi.breaking': executor<{ file: string; baseFile: string }>(async ({ file, baseFile }, ctx) => {
    for (const name of [file, baseFile]) {
      if (workSize(ctx, name) === null) return { count: 0, breaking: [], error: missingFile(name) };
    }
    return breaking(workPath(ctx, baseFile), workPath(ctx, file));
  }),
};

