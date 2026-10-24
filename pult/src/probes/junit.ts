import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { asRecord, str } from './http';
import { executor, type ExecutorTable } from './types';
import { ProbeError } from './errors';
import { listWorkFiles, MAX_LISTED_REPORTS, readWorkText, workSize } from './work';

export type JunitStatus = 'passed' | 'failed' | 'error' | 'skipped';
export type JunitCase = { name: string; classname: string; status: JunitStatus; message: string; file: string };
export type JunitGroup = { name: string; classname: string; count: number; passed: number; failed: number };

const DEFAULT_DIR = 'reports';
const MAX_CASES = 500;
const MAX_MESSAGE = 300;
const GROUP_SUFFIX = /[[(].*$/s;

function many(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  textNodeName: '#text',
  processEntities: false,
});

const MAX_REPORT_BYTES = 5 * 1024 * 1024;

function messageOf(node: unknown): string {
  const record = asRecord(node);
  const attribute = str(record['@_message']);
  const text = typeof node === 'string' ? node : str(record['#text']);
  return (attribute || text).trim().slice(0, MAX_MESSAGE);
}

function statusOf(testcase: Record<string, unknown>): { status: JunitStatus; message: string } {
  for (const [key, status] of [
    ['failure', 'failed'],
    ['error', 'error'],
    ['skipped', 'skipped'],
  ] as const) {
    if (key in testcase) return { status, message: messageOf(many(testcase[key])[0]) };
  }
  return { status: 'passed', message: '' };
}

function collectCases(node: unknown, file: string, out: JunitCase[]): void {
  const record = asRecord(node);
  for (const testcase of many(record.testcase)) {
    const row = asRecord(testcase);
    out.push({ name: str(row['@_name']), classname: str(row['@_classname']), file, ...statusOf(row) });
  }
  for (const suite of many(record.testsuite)) collectCases(suite, file, out);
  if (record.testsuites !== undefined) {
    for (const suites of many(record.testsuites)) collectCases(suites, file, out);
  }
}

export function parseJunitFile(text: string, file: string): { cases: JunitCase[]; error: string | null } {
  const valid = XMLValidator.validate(text);
  if (valid !== true) return { cases: [], error: `${file}: ${valid.err.msg}` };
  const cases: JunitCase[] = [];
  collectCases(parser.parse(text), file, cases);
  return { cases, error: null };
}

export function groupName(name: string): string {
  const base = name.replace(GROUP_SUFFIX, '').trim();
  return base || name;
}

const JUNIT5_INDEX = /^\[\d+\]/;

function groupKey(item: JunitCase): { name: string; classname: string } {
  if (JUNIT5_INDEX.test(item.name)) return { name: item.classname || item.name, classname: item.classname };
  if (/[[(]/.test(item.name.slice(1))) return { name: groupName(item.name), classname: item.classname === item.name ? '' : item.classname };
  return { name: item.name, classname: item.classname };
}

export function groupCases(cases: JunitCase[]): JunitGroup[] {
  const groups = new Map<string, JunitGroup>();
  for (const item of cases) {
    const { name, classname } = groupKey(item);
    const key = `${classname}\u0000${name}`;
    const group = groups.get(key) ?? { name, classname, count: 0, passed: 0, failed: 0 };
    group.count += 1;
    if (item.status === 'passed') group.passed += 1;
    if (item.status === 'failed' || item.status === 'error') group.failed += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

const TESTNG_RESULTS = 'testng-results.xml';
const TESTNG_JUNIT_DIR = 'junitreports/';

export function withoutTestngDuplicates(paths: string[]): string[] {
  const roots = [
    ...new Set(paths.filter((path) => path.endsWith(TESTNG_RESULTS)).map((path) => path.slice(0, path.length - TESTNG_RESULTS.length))),
  ];
  if (!roots.length) return paths;
  const duplicate = (path: string): boolean =>
    roots.some((root) => {
      if (!path.startsWith(root)) return false;
      const inner = path.slice(root.length);
      if (inner.startsWith(TESTNG_JUNIT_DIR)) return false;
      return root === '' ? inner.startsWith('testng-') && !inner.includes('/') : inner.includes('/') || inner.startsWith('testng-');
    });
  return paths.filter((path) => !duplicate(path));
}

export function junitFacts(files: string[], cases: JunitCase[], parseErrors: string[]) {
  const count = (status: JunitStatus) => cases.filter((item) => item.status === status).length;
  const failures = count('failed');
  const errored = count('error');
  const groups = groupCases(cases);
  const largest = groups.reduce<JunitGroup | null>((best, group) => (best && best.count >= group.count ? best : group), null);
  const broken = cases.filter((item) => item.status === 'failed' || item.status === 'error');
  return {
    exists: files.length > 0,
    files,
    parseErrors,
    tests: cases.length,
    passed: count('passed'),
    failures,
    errors: errored,
    failed: failures + errored,
    allPassed: cases.length > 0 && failures + errored === 0,
    skipped: count('skipped'),
    cases: cases.slice(0, MAX_CASES).map(({ name, classname, status, message }) => ({ name, classname, status, message })),
    failedNames: [...new Set(broken.flatMap((item) => [item.name, item.classname ? `${item.classname}.${item.name}` : item.name]))],
    groups,
    largestGroup: largest,
    maxGroupSize: largest?.count ?? 0,
  };
}

export const JUNIT_EXECUTORS: ExecutorTable = {
  'junit.report': executor<{ dir?: string }>(async ({ dir }, ctx) => {
    const root = dir ?? DEFAULT_DIR;
    const listed = listWorkFiles(ctx, root, (path) => path.toLowerCase().endsWith('.xml'));
    const paths = withoutTestngDuplicates(listed.files);
    if (listed.count > listed.files.length) {
      throw new ProbeError(`В work/${root} слишком много отчётов (${listed.count}): оставьте не больше ${MAX_LISTED_REPORTS}`);
    }
    const files: string[] = [];
    const cases: JunitCase[] = [];
    const parseErrors: string[] = [];
    for (const path of paths) {
      const size = workSize(ctx, `${root}/${path}`);
      if (size !== null && size > MAX_REPORT_BYTES) {
        parseErrors.push(`${path}: отчёт слишком большой (больше ${MAX_REPORT_BYTES / 1024 / 1024} МБ)`);
        continue;
      }
      const text = readWorkText(ctx, `${root}/${path}`);
      if (text === null) continue;
      const parsed = parseJunitFile(text, path);
      if (parsed.error) parseErrors.push(parsed.error);
      else files.push(path);
      for (const item of parsed.cases) cases.push(item);
    }
    return junitFacts(files, cases, parseErrors);
  }),
};
