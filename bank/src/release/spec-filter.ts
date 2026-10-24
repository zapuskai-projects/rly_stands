import { parse, stringify } from 'yaml';
import { parseRelease, releaseAtLeast, type Release } from './release';

type Json = Record<string, unknown>;

const MARK = 'x-release';
const VALUES_MARK = 'x-release-values';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const COMPONENT_REF = /^#\/components\/([^/]+)\/([^/]+)/;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function isHidden(node: unknown, current: Release): boolean {
  if (!isObject(node) || node[MARK] === undefined) return false;
  return !releaseAtLeast(current, parseRelease(String(node[MARK]), MARK));
}

function cut(node: unknown, current: Release): unknown {
  if (Array.isArray(node)) return node.filter((item) => !isHidden(item, current)).map((item) => cut(item, current));
  if (!isObject(node)) return node;
  const result: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (!isHidden(value, current)) result[key] = cut(value, current);
  }
  if (Array.isArray(node.oneOf) && Array.isArray(result.oneOf) && result.oneOf.length === 1 && node.oneOf.length > 1) {
    const { oneOf, ...rest } = result;
    return { ...rest, ...(oneOf[0] as Json) };
  }
  if (isObject(node.properties) && Array.isArray(result.required)) {
    const hidden = Object.entries(node.properties).filter(([, value]) => isHidden(value, current)).map(([name]) => name);
    result.required = result.required.filter((name) => !hidden.includes(String(name)));
  }
  cutEnumValues(node, result, current);
  return result;
}

function cutEnumValues(node: Json, result: Json, current: Release): void {
  const marks = node[VALUES_MARK];
  if (!isObject(marks) || !Array.isArray(result.enum)) return;
  const shown = Object.entries(marks).filter(([, release]) => releaseAtLeast(current, parseRelease(String(release), VALUES_MARK)));
  const hidden = Object.keys(marks).filter((value) => !shown.some(([name]) => name === value));
  result.enum = result.enum.filter((value) => !hidden.includes(String(value)));
  if (shown.length === 0) delete result[VALUES_MARK];
  else result[VALUES_MARK] = Object.fromEntries(shown);
}

function dropEmptyPaths(original: Json, filtered: Json): void {
  if (!isObject(original.paths) || !isObject(filtered.paths)) return;
  for (const [path, item] of Object.entries(original.paths)) {
    const hadOperations = isObject(item) && HTTP_METHODS.some((method) => method in item);
    const left = filtered.paths[path];
    if (hadOperations && isObject(left) && !HTTP_METHODS.some((method) => method in left)) delete filtered.paths[path];
  }
}

function reachableComponents(document: Json): Set<string> {
  const found = new Set<string>();
  const components = isObject(document.components) ? document.components : {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const match = key === '$ref' && typeof value === 'string' ? COMPONENT_REF.exec(value) : null;
      if (!match) {
        visit(value);
        continue;
      }
      const id = `${match[1]}/${match[2]}`;
      if (found.has(id)) continue;
      found.add(id);
      const section = components[match[1] as string];
      if (isObject(section)) visit(section[match[2] as string]);
    }
  };
  for (const [key, value] of Object.entries(document)) {
    if (key !== 'components') visit(value);
  }
  return found;
}

function dropOrphanComponents(original: Json, filtered: Json): void {
  if (!isObject(filtered.components)) return;
  const before = reachableComponents(original);
  const after = reachableComponents(filtered);
  for (const id of before) {
    if (after.has(id)) continue;
    const [section, name] = id.split('/') as [string, string];
    const group = (filtered.components as Json)[section];
    if (!isObject(group)) continue;
    delete group[name];
    if (Object.keys(group).length === 0) delete (filtered.components as Json)[section];
  }
}

export function filterSpec(document: Json, current: Release): Json {
  const filtered = cut(document, current) as Json;
  dropEmptyPaths(document, filtered);
  dropOrphanComponents(document, filtered);
  return filtered;
}

export function specForRelease(source: string, current: Release): string {
  const document = parse(source) as Json;
  const filtered = filterSpec(document, current);
  if (JSON.stringify(filtered) === JSON.stringify(document)) return source;
  return stringify(filtered, { lineWidth: 0 });
}
