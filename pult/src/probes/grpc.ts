import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Enum, parse, Service, Type, type Field, type MapField, type Namespace } from 'protobufjs';
import { run } from '../docker/exec';
import { errorText, ProbeError } from './errors';
import { asRecord, num, str } from './http';
import { executor, type ExecutorTable } from './types';
import { missingFile, readWorkText, workPath, workSize } from './work';

const BUF_TIMEOUT_MS = 60_000;
const PROTO_NAME = 'doc.proto';
const LINT_CONFIG = `version: v2
lint:
  use:
    - STANDARD
  except:
    - PACKAGE_DIRECTORY_MATCH
    - SERVICE_SUFFIX
breaking:
  use:
    - FILE
`;

function collect(namespace: Namespace, out: { services: Service[]; types: Type[]; enums: Enum[] }): void {
  for (const nested of namespace.nestedArray) {
    if (nested instanceof Service) out.services.push(nested);
    else if (nested instanceof Enum) out.enums.push(nested);
    else if (nested instanceof Type) {
      out.types.push(nested);
      collect(nested, out);
    } else if ('nestedArray' in nested) collect(nested as Namespace, out);
  }
}

function fieldType(field: Field): string {
  const map = field as unknown as MapField;
  return map.map ? `map<${map.keyType},${field.type}>` : field.type;
}

const failed = (errors: string[]) => ({ parsed: false, errors, package: '', services: [], messages: [], enums: [] });

export function describeProto(text: string) {
  try {
    const parsed = parse(text, { keepCase: true });
    const found = { services: [] as Service[], types: [] as Type[], enums: [] as Enum[] };
    collect(parsed.root, found);
    return {
      parsed: true,
      errors: [],
      package: parsed.package ?? '',
      services: found.services.map((service) => ({
        name: service.name,
        methods: service.methodsArray.map((method) => ({
          name: method.name,
          input: method.requestType,
          output: method.responseType,
          clientStreaming: method.requestStream === true,
          serverStreaming: method.responseStream === true,
        })),
      })),
      messages: found.types.map((type) => ({
        name: type.name,
        fields: type.fieldsArray.map((field) => ({
          name: field.name,
          type: fieldType(field),
          number: field.id,
          repeated: field.repeated === true,
        })),
      })),
      enums: found.enums.map((item) => ({
        name: item.name,
        values: Object.entries(item.values).map(([name, number]) => ({ name, number })),
      })),
    };
  } catch (error) {
    return failed([errorText(error)]);
  }
}

function problemsOf(output: string) {
  return output
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.startsWith('{'))
    .map((row) => {
      try {
        const item = asRecord(JSON.parse(row));
        return { line: num(item.start_line), rule: str(item.type), message: str(item.message) };
      } catch {
        return null;
      }
    })
    .filter((item): item is { line: number; rule: string; message: string } => item !== null);
}

async function buf(args: string[], cwd: string) {
  const result = await run('buf', args, { cwd, timeoutMs: BUF_TIMEOUT_MS });
  if (result.code === 127 || /not found|ENOENT/.test(result.stderr)) {
    throw new ProbeError('В образе пульта нет buf');
  }
  const problems = problemsOf(result.stdout || result.stderr);
  if (result.code !== 0 && !problems.length) {
    const reason = (result.stderr || result.stdout).trim().split('\n')[0] ?? 'buf завершился с ошибкой';
    return { count: 1, problems: [{ line: 0, rule: 'BUF', message: reason.slice(0, 300) }] };
  }
  return { count: problems.length, problems };
}

function prepare(dir: string, name: string, source: string): string {
  const module = join(dir, name);
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, 'buf.yaml'), LINT_CONFIG);
  copyFileSync(source, join(module, PROTO_NAME));
  return module;
}

export const GRPC_EXECUTORS: ExecutorTable = {
  'grpc.protoDescribe': executor<{ file: string }>(async ({ file }, ctx) => {
    const text = readWorkText(ctx, file);
    return text === null ? failed([missingFile(file, ctx)]) : describeProto(text);
  }),

  'grpc.protoLint': executor<{ file: string }>(async ({ file }, ctx) => {
    if (workSize(ctx, file) === null) return { count: 1, problems: [{ line: 0, rule: 'FILE', message: missingFile(file, ctx) }] };
    const dir = mkdtempSync(join(tmpdir(), 'kit-buf-'));
    try {
      const module = prepare(dir, 'current', workPath(ctx, file));
      return await buf(['lint', '--error-format=json', '.'], module);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  'grpc.protoBreaking': executor<{ file: string; baseProto: string }>(async ({ file, baseProto }, ctx) => {
    for (const name of [file, baseProto]) {
      if (workSize(ctx, name) === null) return { count: 1, problems: [{ line: 0, rule: 'FILE', message: missingFile(name, ctx) }] };
    }
    const dir = mkdtempSync(join(tmpdir(), 'kit-buf-'));
    try {
      const current = prepare(dir, 'current', workPath(ctx, file));
      const base = prepare(dir, 'base', workPath(ctx, baseProto));
      return await buf(['breaking', '.', '--against', base, '--error-format=json'], current);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
};
