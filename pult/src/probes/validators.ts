import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export type Dialect = 'draft07' | '2019' | '2020';

type AnyAjv = Ajv | Ajv2019 | Ajv2020;

const INT32_MAX = 2_147_483_647;

export function dialectOf(schemaUrl: unknown): Dialect {
  const url = typeof schemaUrl === 'string' ? schemaUrl : '';
  if (/draft-0[4-7]/.test(url)) return 'draft07';
  if (url.includes('2019-09')) return '2019';
  return '2020';
}

export function createAjv(dialect: Dialect): AnyAjv {
  const options = { allErrors: true, strict: false, validateSchema: false, logger: false as const };
  const ajv: AnyAjv =
    dialect === 'draft07' ? new Ajv(options) : dialect === '2019' ? new Ajv2019(options) : new Ajv2020(options);
  addFormats(ajv);
  ajv.addFormat('int32', { type: 'number', validate: (value: number) => Number.isInteger(value) && Math.abs(value) <= INT32_MAX });
  ajv.addFormat('int64', { type: 'number', validate: (value: number) => Number.isInteger(value) });
  for (const format of ['float', 'double', 'binary', 'byte', 'password']) ajv.addFormat(format, true);
  return ajv;
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 8).map((error) => {
    const where = error.instancePath ? error.instancePath : 'значение';
    const extra =
      error.keyword === 'additionalProperties'
        ? `: ${String((error.params as { additionalProperty?: unknown }).additionalProperty)}`
        : error.keyword === 'required'
          ? `: ${String((error.params as { missingProperty?: unknown }).missingProperty)}`
          : '';
    return `${where} ${error.message ?? 'не проходит схему'}${extra}`;
  });
}

export type SampleResult = { index: number; valid: boolean; expectValid: boolean; ok: boolean; errors: string[] };

export function sampleOutcome(index: number, expectValid: boolean, valid: boolean, errors: string[]): SampleResult {
  return { index, valid, expectValid, ok: valid === expectValid, errors };
}

export function summarize(results: SampleResult[]) {
  return { allOk: results.length > 0 && results.every((item) => item.ok), results };
}

export function validateAgainst(validate: ValidateFunction, data: unknown): { valid: boolean; errors: string[] } {
  const valid = validate(data) === true;
  return { valid, errors: valid ? [] : describeErrors(validate.errors) };
}
