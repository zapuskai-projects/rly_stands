import { sourceLines, unquote } from './common';

export type ParticipantKind =
  | 'participant'
  | 'actor'
  | 'boundary'
  | 'control'
  | 'entity'
  | 'database'
  | 'collections'
  | 'queue';

export type SequenceParticipant = { name: string; alias: string | null; id: string; kind: ParticipantKind };

export type SequenceMessage = {
  from: string;
  to: string;
  label: string;
  async: boolean;
  reply: boolean;
};

export type BlockKind = 'alt' | 'opt' | 'loop' | 'par' | 'break' | 'critical' | 'group';

export type SequenceBlock = {
  kind: BlockKind;
  label: string;
  fromMessage: number;
  toMessage: number;
  branches: Array<{ label: string; fromMessage: number }>;
  messages: SequenceMessage[];
};

export type PlacedMessage = SequenceMessage & { block: { index: number; kind: BlockKind } | null };

export type SequenceDiagram = {
  participants: SequenceParticipant[];
  messages: PlacedMessage[];
  blocks: SequenceBlock[];
  errors: string[];
};

const KINDS: ParticipantKind[] = [
  'participant',
  'actor',
  'boundary',
  'control',
  'entity',
  'database',
  'collections',
  'queue',
];
const BLOCKS: BlockKind[] = ['alt', 'opt', 'loop', 'par', 'break', 'critical', 'group'];

const NAME = '"[^"]+"|[\\p{L}\\p{N}_.]+';
const DECLARATION = new RegExp(`^(${KINDS.join('|')})\\s+(${NAME})(?:\\s+as\\s+(${NAME}))?`, 'iu');
const MESSAGE = new RegExp(
  `^(${NAME})\\s*(<{1,2}-{1,2}|-{1,2}>{1,2}|-{1,2}>x|-{1,2}\\\\\\\\?|-{1,2}/)\\s*(${NAME})\\s*(?::\\s*(.*))?$`,
  'u',
);
const BLOCK_OPEN = new RegExp(`^(${BLOCKS.join('|')})\\b\\s*(.*)$`, 'i');

type Registry = {
  byRef: Map<string, SequenceParticipant>;
  participants: SequenceParticipant[];
};

function declare(registry: Registry, name: string, kind: ParticipantKind, alias?: string): SequenceParticipant {
  const display = unquote(name);
  const tag = alias ? unquote(alias) : null;
  let participant = registry.participants.find((item) => item.name === display);
  if (!participant) {
    participant = { name: display, alias: tag, id: tag ?? display, kind };
    registry.participants.push(participant);
  } else {
    if (kind !== 'participant') participant.kind = kind;
    if (tag && !participant.alias) Object.assign(participant, { alias: tag, id: tag });
  }
  registry.byRef.set(display, participant);
  if (tag) registry.byRef.set(tag, participant);
  return participant;
}

function resolve(registry: Registry, raw: string): string {
  const key = unquote(raw);
  return (registry.byRef.get(key) ?? declare(registry, key, 'participant')).id;
}

function directionOf(arrow: string): { reversed: boolean; async: boolean; reply: boolean } {
  const reversed = arrow.startsWith('<');
  return {
    reversed,
    async: arrow.includes('>>') || arrow.includes('<<') || arrow.includes('\\') || arrow.includes('/'),
    reply: arrow.includes('--'),
  };
}

function innermostBlock(blocks: SequenceBlock[], position: number): PlacedMessage['block'] {
  let found: PlacedMessage['block'] = null;
  let span = Infinity;
  blocks.forEach((block, index) => {
    const size = block.toMessage - block.fromMessage;
    if (position >= block.fromMessage && position < block.toMessage && size <= span) {
      found = { index, kind: block.kind };
      span = size;
    }
  });
  return found;
}

export function parseSequence(source: string): SequenceDiagram {
  const registry: Registry = { byRef: new Map(), participants: [] };
  const messages: SequenceMessage[] = [];
  const blocks: SequenceBlock[] = [];
  const errors: string[] = [];
  const open: SequenceBlock[] = [];

  for (const row of sourceLines(source)) {
    const declaration = DECLARATION.exec(row);
    if (declaration) {
      declare(registry, declaration[2] as string, (declaration[1] as string).toLowerCase() as ParticipantKind, declaration[3]);
      continue;
    }
    const message = MESSAGE.exec(row);
    if (message) {
      const direction = directionOf(message[2] as string);
      const left = resolve(registry, message[1] as string);
      const right = resolve(registry, message[3] as string);
      messages.push({
        from: direction.reversed ? right : left,
        to: direction.reversed ? left : right,
        label: (message[4] ?? '').trim(),
        async: direction.async,
        reply: direction.reply,
      });
      continue;
    }
    const start = BLOCK_OPEN.exec(row);
    if (start) {
      const block: SequenceBlock = {
        kind: (start[1] as string).toLowerCase() as BlockKind,
        label: (start[2] ?? '').trim(),
        fromMessage: messages.length,
        toMessage: messages.length,
        branches: [],
        messages: [],
      };
      blocks.push(block);
      open.push(block);
      continue;
    }
    const branch = /^else\b\s*(.*)$/i.exec(row);
    if (branch) {
      const current = open.at(-1);
      if (current) current.branches.push({ label: (branch[1] ?? '').trim(), fromMessage: messages.length });
      else errors.push('else вне блока');
      continue;
    }
    if (/^end$/i.test(row)) {
      const closed = open.pop();
      if (closed) closed.toMessage = messages.length;
      else errors.push('end без начала блока');
    }
  }
  for (const block of open) errors.push(`блок ${block.kind} не закрыт`);
  for (const block of blocks) block.messages = messages.slice(block.fromMessage, block.toMessage);
  const placed = messages.map((message, index) => ({ ...message, block: innermostBlock(blocks, index) }));
  return { participants: registry.participants, messages: placed, blocks, errors };
}
