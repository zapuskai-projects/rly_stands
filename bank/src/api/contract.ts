import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z, type ZodType } from 'zod';
import { parseRelease, type Release } from '../release/release';
import type { ErrorDetail } from '../shared/errors';

z.config(z.locales.ru());

type JsonObject = Record<string, unknown>;

export const ROOT_FIELD = '(корень)';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ValidationResult = { ok: true; value: unknown } | { ok: false; issues: ErrorDetail[] };

export interface Validator {
  validate(value: unknown): ValidationResult;
}

export interface ParamSpec {
  name: string;
  location: 'path' | 'query' | 'header';
  required: boolean;
  coerce: 'number' | null;
  validator: Validator;
}

export interface OperationSpec {
  operationId: string;
  method: HttpMethod;
  openApiPath: string;
  expressPath: string;
  auth: 'NONE' | 'CLIENT' | 'OPERATOR';
  release: Release | null;
  params: ParamSpec[];
  body: { required: boolean; validator: Validator } | null;
  responses: Map<number, Validator | null>;
}

export interface Contract {
  document: JsonObject;
  operations: OperationSpec[];
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: unknown, what: string): JsonObject => {
  if (!isObject(value)) throw new Error(`Контракт: ${what} должен быть объектом`);
  return value;
};

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!isObject(node)) return node;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = key === '$ref' && typeof value === 'string' ? value.replace('#/components/schemas/', '#/$defs/') : rewriteRefs(value);
  }
  return result;
}

function toIssues(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({ field: issue.path.join('.') || ROOT_FIELD, message: issue.message }));
}

function zodValidator(schema: ZodType): Validator {
  return {
    validate(value) {
      const parsed = schema.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: toIssues(parsed.error) };
    },
  };
}

function refName(node: unknown): string | null {
  if (!isObject(node) || typeof node.$ref !== 'string') return null;
  const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
  return match ? (match[1] as string) : null;
}

class SchemaCompiler {
  constructor(private readonly defs: JsonObject) {}

  compile(schema: unknown): Validator {
    const dispatch = this.compileDiscriminated(schema);
    if (dispatch) return dispatch;
    return zodValidator(z.fromJSONSchema({ ...asObject(schema, 'схема'), $defs: this.defs } as z.core.JSONSchema.JSONSchema));
  }

  private compileDiscriminated(schema: unknown): Validator | null {
    const name = refName(schema);
    const target = name ? this.defs[name] : schema;
    if (!isObject(target) || !Array.isArray(target.oneOf) || !isObject(target.discriminator)) return null;
    const property = String(target.discriminator.propertyName);
    const variants = new Map<string, Validator>();
    for (const option of target.oneOf) {
      const optionName = refName(option);
      const optionSchema = optionName ? asObject(this.defs[optionName], optionName) : asObject(option, 'вариант');
      const discriminatorValue = asObject(asObject(optionSchema.properties, 'properties')[property], property).const;
      variants.set(String(discriminatorValue), this.compile(option));
    }
    return {
      validate(value) {
        if (!isObject(value)) return { ok: false, issues: [{ field: ROOT_FIELD, message: 'Ожидался объект' }] };
        const chosen = variants.get(String(value[property]));
        if (!chosen) {
          return {
            ok: false,
            issues: [{ field: property, message: `Допустимые значения: ${[...variants.keys()].join(', ')}` }],
          };
        }
        return chosen.validate(value);
      },
    };
  }
}

function dereference(document: JsonObject, node: unknown): JsonObject {
  let current = asObject(node, 'элемент контракта');
  while (typeof current.$ref === 'string') {
    const path = current.$ref.replace(/^#\//, '').split('/');
    let target: unknown = document;
    for (const segment of path) target = asObject(target, current.$ref as string)[segment];
    current = asObject(target, current.$ref);
  }
  return current;
}

function schemaType(schema: JsonObject, defs: JsonObject): unknown {
  const name = refName(schema);
  return name ? asObject(defs[name], name).type : schema.type;
}

function compileParams(document: JsonObject, rawParams: unknown, compiler: SchemaCompiler, defs: JsonObject): ParamSpec[] {
  const list = Array.isArray(rawParams) ? rawParams : [];
  return list.map((raw): ParamSpec => {
    const param = dereference(document, raw);
    const schema = asObject(rewriteRefs(param.schema), `параметр ${String(param.name)}`);
    const type = schemaType(schema, defs);
    return {
      name: String(param.name),
      location: param.in as ParamSpec['location'],
      required: param.required === true,
      coerce: type === 'integer' || type === 'number' ? 'number' : null,
      validator: compiler.compile(schema),
    };
  });
}

function compileResponses(document: JsonObject, raw: unknown, compiler: SchemaCompiler): Map<number, Validator | null> {
  const responses = new Map<number, Validator | null>();
  for (const [status, node] of Object.entries(asObject(raw, 'responses'))) {
    const response = dereference(document, node);
    const content = isObject(response.content) ? asObject(response.content['application/json'], 'content') : null;
    responses.set(Number(status), content ? compiler.compile(rewriteRefs(content.schema)) : null);
  }
  return responses;
}

function authKind(security: unknown[]): OperationSpec['auth'] {
  const first = security[0];
  if (!isObject(first)) return 'NONE';
  return 'operatorAuth' in first ? 'OPERATOR' : 'CLIENT';
}

function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

export function parseContract(source: string): Contract {
  const document = asObject(parse(source), 'документ');
  const components = asObject(document.components, 'components');
  const defs = asObject(rewriteRefs(components.schemas), 'schemas');
  const compiler = new SchemaCompiler(defs);
  const documentSecurity = Array.isArray(document.security) ? document.security : [];
  const operations: OperationSpec[] = [];
  const seen = new Set<string>();

  for (const [openApiPath, pathItemRaw] of Object.entries(asObject(document.paths, 'paths'))) {
    const pathItem = asObject(pathItemRaw, openApiPath);
    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue;
      const operation = asObject(pathItem[method], `${method} ${openApiPath}`);
      const operationId = String(operation.operationId);
      if (seen.has(operationId)) throw new Error(`Контракт: operationId ${operationId} повторяется`);
      seen.add(operationId);
      const security = Array.isArray(operation.security) ? operation.security : documentSecurity;
      const requestBody = isObject(operation.requestBody) ? operation.requestBody : null;
      const bodyContent = requestBody && isObject(requestBody.content) ? asObject(requestBody.content['application/json'], 'content') : null;
      operations.push({
        operationId,
        method,
        openApiPath,
        expressPath: toExpressPath(openApiPath),
        auth: authKind(security),
        release: operation['x-release'] === undefined ? null : parseRelease(String(operation['x-release']), `Контракт: ${operationId}`),
        params: compileParams(document, [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])], compiler, defs),
        body: bodyContent ? { required: requestBody?.required === true, validator: compiler.compile(rewriteRefs(bodyContent.schema)) } : null,
        responses: compileResponses(document, operation.responses, compiler),
      });
    }
  }
  return { document, operations };
}

export function loadContract(filePath: string): Contract {
  return parseContract(readFileSync(filePath, 'utf8'));
}
