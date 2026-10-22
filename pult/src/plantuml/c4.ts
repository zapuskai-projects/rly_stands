import { sourceLines, splitArguments } from './common';

export type C4ElementKind =
  | 'Person'
  | 'System'
  | 'SystemDb'
  | 'SystemQueue'
  | 'Container'
  | 'ContainerDb'
  | 'ContainerQueue'
  | 'Component'
  | 'ComponentDb'
  | 'ComponentQueue';

export type C4Element = {
  kind: C4ElementKind;
  alias: string;
  label: string;
  technology: string | null;
  description: string | null;
  external: boolean;
  boundary: string | null;
};

export type C4Relation = {
  from: string;
  to: string;
  label: string;
  technology: string | null;
};

export type C4Diagram = {
  elements: C4Element[];
  relations: C4Relation[];
  errors: string[];
};

const ELEMENT_KINDS: C4ElementKind[] = [
  'Person',
  'System',
  'SystemDb',
  'SystemQueue',
  'Container',
  'ContainerDb',
  'ContainerQueue',
  'Component',
  'ComponentDb',
  'ComponentQueue',
];
const WITH_TECHNOLOGY = new Set<C4ElementKind>(
  ELEMENT_KINDS.filter((kind) => kind.startsWith('Container') || kind.startsWith('Component')),
);

const MACRO = /^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?\s*$/;
const BOUNDARY = /^(?:Enterprise_Boundary|System_Boundary|Container_Boundary|Boundary)$/;
const RELATION = /^(Rel|BiRel|Rel_Back|Rel_Neighbor|Rel_[UDLR]|BiRel_[UDLR])$/;

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function elementOf(macro: string): { kind: C4ElementKind; external: boolean } | null {
  const external = macro.endsWith('_Ext');
  const base = external ? macro.slice(0, -4) : macro;
  const kind = ELEMENT_KINDS.find((candidate) => candidate === base);
  return kind ? { kind, external } : null;
}

export function parseC4(source: string): C4Diagram {
  const elements: C4Element[] = [];
  const relations: C4Relation[] = [];
  const errors: string[] = [];
  const boundaries: string[] = [];

  for (const row of sourceLines(source)) {
    if (row === '}') {
      if (boundaries.pop() === undefined) errors.push('закрывающая } без Boundary');
      continue;
    }
    const macro = MACRO.exec(row);
    if (!macro) continue;
    const name = macro[1] as string;
    const args = splitArguments(macro[2] as string);
    if (BOUNDARY.test(name)) {
      if (macro[3]) boundaries.push(args[1] ?? args[0] ?? '');
      continue;
    }
    const element = elementOf(name);
    if (element) {
      const technologyAt = WITH_TECHNOLOGY.has(element.kind) ? 2 : -1;
      const descriptionAt = technologyAt === -1 ? 2 : 3;
      elements.push({
        kind: element.kind,
        alias: args[0] ?? '',
        label: args[1] ?? '',
        technology: technologyAt === -1 ? null : nonEmpty(args[technologyAt]),
        description: nonEmpty(args[descriptionAt]),
        external: element.external,
        boundary: boundaries.at(-1) ?? null,
      });
      continue;
    }
    if (RELATION.test(name)) {
      const swap = name === 'Rel_Back';
      const [from = '', to = ''] = args;
      relations.push({
        from: swap ? to : from,
        to: swap ? from : to,
        label: args[2] ?? '',
        technology: nonEmpty(args[3]),
      });
    }
  }
  const aliases = new Set(elements.map((element) => element.alias));
  for (const relation of relations) {
    for (const end of [relation.from, relation.to]) {
      if (!aliases.has(end)) errors.push(`связь ссылается на неизвестный элемент ${end}`);
    }
  }
  if (boundaries.length) errors.push('Boundary не закрыт');
  return { elements, relations, errors };
}
