import { sourceLines, unquote } from './common';

export type StateNode = {
  name: string;
  alias: string;
  description: string | null;
  parent: string | null;
};

export type StateTransition = {
  from: string;
  to: string;
  label: string | null;
  scope: string | null;
};

export type StateDiagram = {
  states: StateNode[];
  transitions: StateTransition[];
  errors: string[];
};

export const INITIAL_MARK = '[*]';

const NAME = '\\[\\*\\]|"[^"]+"|[\\p{L}\\p{N}_.]+';
const FORWARD = '(?:-+|\\.+)(?:\\[[^\\]]*\\])?(?:[a-z]+)?(?:-+|\\.+)?>';
const BACKWARD = '<(?:-+|\\.+)(?:\\[[^\\]]*\\])?(?:[a-z]+)?(?:-+|\\.+)?';
const TRANSITION = new RegExp(`^(${NAME})\\s*(${FORWARD}|${BACKWARD})\\s*(${NAME})(?:\\s*:\\s*(.*))?$`, 'u');
const DESCRIPTION = new RegExp(`^(${NAME})\\s*:\\s*(.+)$`, 'u');
const DECLARATION = new RegExp(
  `^state\\s+(?:"([^"]+)"|(${NAME}))(?:\\s+as\\s+(${NAME}))?(?:\\s*<<[^>]*>>)?(?:\\s*#{1,2}[^\\s{:]*)?(?:\\s*:\\s*(.*?))?\\s*(\\{)?\\s*$`,
  'iu',
);

type Registry = {
  states: StateNode[];
  byAlias: Map<string, StateNode>;
};

function declare(registry: Registry, name: string, alias: string | null, parent: string | null): StateNode {
  const key = alias ?? name;
  const known = registry.byAlias.get(key) ?? registry.byAlias.get(name);
  if (known) {
    if (alias) registry.byAlias.set(alias, known);
    return known;
  }
  const node: StateNode = { name, alias: key, description: null, parent };
  registry.states.push(node);
  registry.byAlias.set(key, node);
  registry.byAlias.set(name, node);
  return node;
}

function resolveName(registry: Registry, raw: string, parent: string | null): string {
  if (raw === INITIAL_MARK) return INITIAL_MARK;
  const key = unquote(raw);
  return (registry.byAlias.get(key) ?? declare(registry, key, null, parent)).name;
}

export function parseState(source: string): StateDiagram {
  const registry: Registry = { states: [], byAlias: new Map() };
  const transitions: StateTransition[] = [];
  const errors: string[] = [];
  const scopes: string[] = [];

  for (const row of sourceLines(source)) {
    const scope = scopes.at(-1) ?? null;
    const declaration = DECLARATION.exec(row);
    if (declaration) {
      const name = declaration[1] ?? (declaration[2] as string);
      const node = declare(registry, unquote(name), declaration[3] ? unquote(declaration[3]) : null, scope);
      if (declaration[4]) node.description = declaration[4].trim();
      if (declaration[5]) scopes.push(node.name);
      continue;
    }
    const transition = TRANSITION.exec(row);
    if (transition) {
      const reversed = (transition[2] as string).startsWith('<');
      const left = resolveName(registry, transition[1] as string, scope);
      const right = resolveName(registry, transition[3] as string, scope);
      transitions.push({
        from: reversed ? right : left,
        to: reversed ? left : right,
        label: transition[4]?.trim() || null,
        scope,
      });
      continue;
    }
    const description = DESCRIPTION.exec(row);
    if (description) {
      const name = resolveName(registry, description[1] as string, scope);
      const node = registry.states.find((item) => item.name === name);
      if (node) node.description = [node.description, (description[2] as string).trim()].filter(Boolean).join(' ');
      continue;
    }
    if (row === '}') {
      if (scopes.pop() === undefined) errors.push('закрывающая скобка без состояния');
    }
  }
  for (const open of scopes) errors.push(`блок состояния ${open} не закрыт`);
  return { states: registry.states, transitions, errors };
}
