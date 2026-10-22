import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../docker/exec';
import { ProbeError } from './errors';
import { executor, type ExecutorTable } from './types';
import { sampleOutcome, summarize, type SampleResult } from './validators';
import { missingFile, workPath, workSize } from './work';

const MAX_VALUES = 50;
const XMLLINT_TIMEOUT_MS = 20_000;
const XMLLINT_MISSING = 'В образе пульта нет xmllint';

type XmlSample = { xml: string; expectValid: boolean };

async function xmllint(args: string[]) {
  const result = await run('xmllint', args, { timeoutMs: XMLLINT_TIMEOUT_MS });
  if (result.code === 127 || /not found|ENOENT/.test(result.stderr)) throw new ProbeError(XMLLINT_MISSING);
  return result;
}

function cleanLines(output: string, file: string): string[] {
  return output
    .split('\n')
    .map((row) => row.replace(file, 'строка').trim())
    .filter((row) => row && !row.endsWith('validates') && !row.endsWith('fails to validate'))
    .slice(0, 6);
}

export async function xpathValues(file: string, xpath: string) {
  const counted = await xmllint(['--xpath', `count(${xpath})`, file]);
  if (counted.code !== 0) {
    const reason = counted.stderr.split('\n').find((row) => row.trim()) ?? 'ошибка XPath или XML';
    return { parsed: false, count: 0, values: [] as string[], errors: [reason.replace(file, 'файл').trim()] };
  }
  const count = Number(counted.stdout.trim());
  if (!Number.isFinite(count)) {
    const single = await xmllint(['--xpath', xpath, file]);
    return { parsed: true, count: 1, values: [single.stdout.replace(/\r?\n$/, '')], errors: [] as string[] };
  }
  const values: string[] = [];
  for (let i = 1; i <= Math.min(count, MAX_VALUES); i += 1) {
    const value = await xmllint(['--xpath', `string((${xpath})[${i}])`, file]);
    values.push(value.stdout.replace(/\r?\n$/, ''));
  }
  return { parsed: true, count, values, errors: [] as string[] };
}

export async function checkXsdSamples(xsdFile: string, samples: XmlSample[]) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-xsd-'));
  try {
    const results: SampleResult[] = [];
    for (const [index, sample] of samples.entries()) {
      const target = join(dir, `sample-${index}.xml`);
      writeFileSync(target, sample.xml, 'utf8');
      const checked = await xmllint(['--noout', '--schema', xsdFile, target]);
      const errors = cleanLines(checked.stderr, target);
      const schemaBroken = checked.code === 5 || checked.code === 6 || /Schemas parser error|failed to compile/i.test(checked.stderr);
      if (schemaBroken) {
        results.push({ ...sampleOutcome(index, sample.expectValid, false, [`XSD не разобрана: ${errors[0] ?? 'ошибка схемы'}`]), ok: false });
      } else {
        results.push(sampleOutcome(index, sample.expectValid, checked.code === 0, checked.code === 0 ? [] : errors));
      }
    }
    return summarize(results);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const XML_EXECUTORS: ExecutorTable = {
  'xml.xpath': executor<{ file: string; xpath: string }>(async ({ file, xpath }, ctx) => {
    if (workSize(ctx, file) === null) return { parsed: false, count: 0, values: [], errors: [missingFile(file)] };
    return xpathValues(workPath(ctx, file), xpath);
  }),

  'xsd.samples': executor<{ xsdFile: string; samples: XmlSample[] }>(async ({ xsdFile, samples }, ctx) => {
    if (workSize(ctx, xsdFile) === null) {
      return summarize(samples.map((sample, index) => ({ ...sampleOutcome(index, sample.expectValid, false, [missingFile(xsdFile)]), ok: false })));
    }
    return checkXsdSamples(workPath(ctx, xsdFile), samples);
  }),
};
