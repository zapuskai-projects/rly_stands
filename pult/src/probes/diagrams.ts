import { deflateRawSync } from 'node:zlib';
import { parseBpmn } from './bpmn';
import { parseC4 } from '../plantuml/c4';
import { parseClasses } from '../plantuml/classes';
import { parseSequence } from '../plantuml/sequence';
import { INITIAL_MARK, parseState } from '../plantuml/state';
import { http } from './http';
import { executor, type ExecutorTable } from './types';
import { missingFile, readWorkText } from './work';

const MODULE = 'PlantUML-сервер';
const SERVER = 'http://plantuml:8080/txt';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

export function encodePlantuml(source: string): string {
  const bytes = deflateRawSync(Buffer.from(source, 'utf8'));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]! + ALPHABET[((b & 15) << 2) | (c >> 6)]! + ALPHABET[c & 63]!;
  }
  return out;
}

export function extractTitle(source: string): string {
  const single = /^[ \t]*title[ \t]+(\S.*)$/im.exec(source);
  if (single?.[1]) return single[1].trim();
  const block = /^\s*title\s*$\n([\s\S]*?)^\s*end\s+title\s*$/im.exec(source);
  return block?.[1] ? block[1].split('\n').map((row) => row.trim()).filter(Boolean).join(' ') : '';
}

async function serverErrors(source: string): Promise<string[]> {
  const result = await http(MODULE, `${SERVER}/${encodePlantuml(source)}`, { timeoutMs: 20_000 });
  if (result.status === 200) return [];
  const message = result.headers['x-plantuml-diagram-error'] ?? 'ошибка синтаксиса';
  const line = result.headers['x-plantuml-diagram-error-line'];
  return [line ? `строка ${line}: ${message}` : message];
}

const participantText = (participant: { name: string; alias: string | null; id: string }) =>
  [...new Set([participant.name, participant.alias, participant.id].filter(Boolean))].join(' ');

export function sequenceFacts(source: string) {
  const parsed = parseSequence(source);
  const textOf = (id: string) => {
    const participant = parsed.participants.find((item) => item.id === id);
    return participant ? participantText(participant) : id;
  };
  const messages = parsed.messages.map((message) => ({ ...message, fromText: textOf(message.from), toText: textOf(message.to) }));
  const blocks = parsed.blocks.map((block) => ({
    ...block,
    hasElse: block.branches.length > 0,
    text: [block.label, ...block.branches.map((branch) => branch.label), ...block.messages.map((message) => message.label)].join('\n'),
  }));
  const participantsText = parsed.participants.map(participantText).join('\n');
  return {
    title: extractTitle(source),
    syntaxErrors: parsed.errors,
    participants: parsed.participants,
    participantsText,
    messages,
    targetsText: messages.map((message) => message.toText).join('\n'),
    blocks,
    text: [participantsText, ...messages.map((message) => message.label), ...blocks.map((block) => block.text)].join('\n'),
  };
}

export function linkPairs(relations: Array<{ from: string; to: string }>): string[] {
  return [...new Set(relations.map((item) => [item.from, item.to].sort().join('--')))].sort();
}

export function classFacts(source: string) {
  const parsed = parseClasses(source);
  return {
    title: extractTitle(source),
    syntaxErrors: parsed.errors,
    classes: parsed.classes,
    relations: parsed.relations,
    linkPairs: linkPairs(parsed.relations),
  };
}

export function stateFacts(source: string) {
  const parsed = parseState(source);
  return {
    title: extractTitle(source),
    syntaxErrors: parsed.errors,
    states: parsed.states,
    transitions: parsed.transitions,
    transitionsWithoutFinal: parsed.transitions.filter((item) => item.to !== INITIAL_MARK),
    edges: parsed.transitions.map((item) => `${item.from} -> ${item.to}`),
  };
}

export function c4Facts(source: string) {
  const parsed = parseC4(source);
  return {
    title: extractTitle(source),
    syntaxErrors: parsed.errors,
    elements: parsed.elements,
    relations: parsed.relations,
    relationsText: parsed.relations.map((item) => [item.label, item.technology].filter(Boolean).join(' ')).join('\n'),
    elementsText: parsed.elements.map((item) => [item.label, item.technology].filter(Boolean).join(' ')).join('\n'),
  };
}

async function diagramProbe<T extends { syntaxErrors: string[] }>(
  source: string | null,
  file: string,
  facts: (text: string) => T,
  empty: Omit<T, 'title' | 'syntaxErrors'>,
) {
  if (source === null) return { title: '', syntaxErrors: [missingFile(file)], ...empty };
  const own = facts(source);
  return { ...own, syntaxErrors: [...own.syntaxErrors, ...(await serverErrors(source))] };
}

export const DIAGRAM_EXECUTORS: ExecutorTable = {
  'plantuml.sequence': executor<{ file: string }>(({ file }, ctx) =>
    diagramProbe(readWorkText(ctx, file), file, sequenceFacts, { participants: [], participantsText: '', messages: [], targetsText: '', blocks: [], text: '' }),
  ),

  'plantuml.class': executor<{ file: string }>(({ file }, ctx) =>
    diagramProbe(readWorkText(ctx, file), file, classFacts, { classes: [], relations: [], linkPairs: [] }),
  ),

  'plantuml.state': executor<{ file: string }>(({ file }, ctx) =>
    diagramProbe(readWorkText(ctx, file), file, stateFacts, { states: [], transitions: [], transitionsWithoutFinal: [], edges: [] }),
  ),

  'plantuml.c4': executor<{ file: string }>(({ file }, ctx) =>
    diagramProbe(readWorkText(ctx, file), file, c4Facts, { elements: [], relations: [], relationsText: '', elementsText: '' }),
  ),

  'bpmn.file': executor<{ file: string }>(async ({ file }, ctx) => {
    const text = readWorkText(ctx, file);
    return text === null
      ? { parsed: false, errors: [missingFile(file)], processIds: [], counts: {}, elements: [], flows: [], participants: [], lanes: [] }
      : parseBpmn(text);
  }),
};
