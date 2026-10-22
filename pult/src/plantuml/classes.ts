import { sourceLines, unquote } from './common';

export type ClassKind = 'class' | 'interface' | 'abstract' | 'enum';
export type Visibility = '+' | '-' | '#' | '~' | null;

export type ClassAttribute = { name: string; type: string | null; visibility: Visibility };

export type ClassModel = {
  name: string;
  kind: ClassKind;
  attributes: ClassAttribute[];
  methods: string[];
  values: string[];
};

export type RelationKind =
  | 'inheritance'
  | 'realization'
  | 'composition'
  | 'aggregation'
  | 'association'
  | 'dependency';

export type ClassRelation = {
  from: string;
  to: string;
  kind: RelationKind;
  directed: boolean;
  fromMultiplicity: string | null;
  toMultiplicity: string | null;
  label: string | null;
};

export type ClassDiagram = {
  classes: ClassModel[];
  relations: ClassRelation[];
  errors: string[];
};

const NAME = '[\\p{L}\\p{N}_.]+';
const DECLARATION = new RegExp(
  `^(abstract\\s+class|abstract|class|interface|enum)\\s+("[^"]+"|${NAME})(?:\\s+as\\s+(${NAME}))?[^{]*(\\{)?\\s*(\\})?$`,
  'iu',
);
const MEMBER_LINE = new RegExp(`^(${NAME})\\s*:\\s*(.+)$`, 'u');
const RELATION = new RegExp(
  `^(${NAME})\\s*(?:"([^"]*)")?\\s*(<\\|--|--\\|>|<\\|\\.\\.|\\.\\.\\|>|\\*--|--\\*|o--|--o|<--|-->|<\\.\\.|\\.\\.>|--|\\.\\.)\\s*(?:"([^"]*)")?\\s*(${NAME})\\s*(?::\\s*(.*))?$`,
  'u',
);

function kindOf(word: string): ClassKind {
  const lower = word.toLowerCase();
  if (lower.startsWith('abstract')) return 'abstract';
  return lower as ClassKind;
}

function parseMember(text: string): { attribute?: ClassAttribute; method?: string } {
  const cleaned = text.replace(/\{(static|abstract)\}\s*/g, '').trim();
  const visibilityMatch = /^([+\-#~])\s*/.exec(cleaned);
  const visibility = (visibilityMatch?.[1] ?? null) as Visibility;
  const body = visibilityMatch ? cleaned.slice(visibilityMatch[0].length) : cleaned;
  if (body.includes('(')) return { method: body };
  const colon = body.indexOf(':');
  if (colon >= 0) {
    return {
      attribute: {
        name: body.slice(0, colon).trim(),
        type: body.slice(colon + 1).trim() || null,
        visibility,
      },
    };
  }
  const parts = body.split(/\s+/);
  if (parts.length >= 2) {
    return { attribute: { name: parts.slice(1).join(' '), type: parts[0] as string, visibility } };
  }
  return { attribute: { name: body, type: null, visibility } };
}

function relationOf(arrow: string, left: string, right: string) {
  const make = (
    from: string,
    to: string,
    kind: RelationKind,
    directed: boolean,
  ): { from: string; to: string; kind: RelationKind; directed: boolean } => ({ from, to, kind, directed });
  switch (arrow) {
    case '<|--':
      return make(right, left, 'inheritance', true);
    case '--|>':
      return make(left, right, 'inheritance', true);
    case '<|..':
      return make(right, left, 'realization', true);
    case '..|>':
      return make(left, right, 'realization', true);
    case '*--':
      return make(left, right, 'composition', true);
    case '--*':
      return make(right, left, 'composition', true);
    case 'o--':
      return make(left, right, 'aggregation', true);
    case '--o':
      return make(right, left, 'aggregation', true);
    case '-->':
      return make(left, right, 'association', true);
    case '<--':
      return make(right, left, 'association', true);
    case '..>':
      return make(left, right, 'dependency', true);
    case '<..':
      return make(right, left, 'dependency', true);
    case '..':
      return make(left, right, 'dependency', false);
    default:
      return make(left, right, 'association', false);
  }
}

export function parseClasses(source: string): ClassDiagram {
  const classes = new Map<string, ClassModel>();
  const aliases = new Map<string, string>();
  const relations: ClassRelation[] = [];
  const errors: string[] = [];
  let current: ClassModel | null = null;

  const ensure = (raw: string): ClassModel => {
    const name = aliases.get(unquote(raw)) ?? unquote(raw);
    let model = classes.get(name);
    if (!model) {
      model = { name, kind: 'class', attributes: [], methods: [], values: [] };
      classes.set(name, model);
    }
    return model;
  };

  for (const row of sourceLines(source)) {
    if (current) {
      if (row === '}') {
        current = null;
        continue;
      }
      if (current.kind === 'enum') {
        current.values.push(row);
        continue;
      }
      if (row === '--' || row === '==' || row === '..') continue;
      const member = parseMember(row);
      if (member.attribute) current.attributes.push(member.attribute);
      if (member.method) current.methods.push(member.method);
      continue;
    }
    const declaration = DECLARATION.exec(row);
    if (declaration) {
      const model = ensure(declaration[2] as string);
      model.kind = kindOf(declaration[1] as string);
      if (declaration[3]) {
        aliases.set(declaration[3], model.name);
      }
      for (const [word, kind] of [
        ['extends', 'inheritance'],
        ['implements', 'realization'],
      ] as const) {
        const parent = new RegExp(`\\b${word}\\s+(${NAME})`, 'iu').exec(row);
        if (parent) {
          relations.push({
            from: model.name,
            to: ensure(parent[1] as string).name,
            kind,
            directed: true,
            fromMultiplicity: null,
            toMultiplicity: null,
            label: null,
          });
        }
      }
      if (declaration[4] && !declaration[5]) current = model;
      continue;
    }
    const relation = RELATION.exec(row);
    if (relation) {
      const left = ensure(relation[1] as string).name;
      const right = ensure(relation[5] as string).name;
      const resolved = relationOf(relation[3] as string, left, right);
      const swapped = resolved.from !== left;
      const leftMultiplicity = relation[2] ?? null;
      const rightMultiplicity = relation[4] ?? null;
      relations.push({
        ...resolved,
        fromMultiplicity: swapped ? rightMultiplicity : leftMultiplicity,
        toMultiplicity: swapped ? leftMultiplicity : rightMultiplicity,
        label: relation[6]?.trim() || null,
      });
      continue;
    }
    const member = MEMBER_LINE.exec(row);
    if (member && classes.has(aliases.get(member[1] as string) ?? (member[1] as string))) {
      const parsed = parseMember(member[2] as string);
      const model = ensure(member[1] as string);
      if (parsed.attribute) model.attributes.push(parsed.attribute);
      if (parsed.method) model.methods.push(parsed.method);
    }
  }
  if (current) errors.push(`класс ${(current as ClassModel).name} не закрыт`);
  return { classes: [...classes.values()], relations, errors };
}
