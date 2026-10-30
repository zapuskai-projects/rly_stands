import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type BoundaryTimer = { timer: string; durationSeconds: number | null; interrupting: boolean };
export type BpmnElement = {
  id: string;
  type: string;
  name: string;
  actors?: string[];
  boundaryTimer?: BoundaryTimer | null;
  attachedTo?: string;
  interrupting?: boolean;
  timer?: string | null;
  durationSeconds?: number | null;
  outgoing?: number;
};
export type BpmnFlow = { id: string; from: string; to: string; condition: string | null };
export type BpmnParticipant = { id: string; name: string; process: string | null };
export type BpmnLane = { id: string; name: string; elements: string[] };

export type BpmnModel = {
  parsed: boolean;
  errors: string[];
  processIds: string[];
  counts: Record<string, number>;
  elements: BpmnElement[];
  flows: BpmnFlow[];
  participants: BpmnParticipant[];
  lanes: BpmnLane[];
};

type Entry = Record<string, unknown>;

const FLOW_NODES = new Set([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
  'task',
  'userTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'manualTask',
  'businessRuleTask',
  'callActivity',
  'subProcess',
  'transaction',
  'adHocSubProcess',
  'exclusiveGateway',
  'inclusiveGateway',
  'parallelGateway',
  'eventBasedGateway',
  'complexGateway',
]);
const NESTED = new Set(['subProcess', 'transaction', 'adHocSubProcess']);
const ATTRS = ':@';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  allowBooleanAttributes: true,
  trimValues: true,
});

const emptyModel = (errors: string[]): BpmnModel => ({
  parsed: false,
  errors,
  processIds: [],
  counts: {},
  elements: [],
  flows: [],
  participants: [],
  lanes: [],
});

function tagOf(entry: Entry): string | null {
  return Object.keys(entry).find((key) => key !== ATTRS && key !== '#text') ?? null;
}

function attr(entry: Entry, name: string): string {
  const value = (entry[ATTRS] as Record<string, unknown> | undefined)?.[`@_${name}`];
  return value === undefined ? '' : String(value);
}

function childrenOf(entry: Entry, tag: string): Entry[] {
  const value = entry[tag];
  return Array.isArray(value) ? (value as Entry[]) : [];
}

function textOf(entries: Entry[]): string {
  return entries
    .map((entry) => (typeof entry['#text'] === 'string' || typeof entry['#text'] === 'number' ? String(entry['#text']) : ''))
    .join('')
    .trim();
}

const TIMER_KINDS = ['timeDuration', 'timeDate', 'timeCycle'];

function timerOf(children: Entry[]): string | null {
  const definition = children.find((child) => tagOf(child) === 'timerEventDefinition');
  if (!definition) return null;
  const inner = childrenOf(definition, 'timerEventDefinition');
  for (const kind of TIMER_KINDS) {
    const node = inner.find((child) => tagOf(child) === kind);
    if (node) return textOf(childrenOf(node, kind)) || null;
  }
  return null;
}

function durationSecondsOf(children: Entry[]): number | null {
  const definition = children.find((child) => tagOf(child) === 'timerEventDefinition');
  if (!definition) return null;
  const duration = childrenOf(definition, 'timerEventDefinition').find((child) => tagOf(child) === 'timeDuration');
  if (!duration) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(textOf(childrenOf(duration, 'timeDuration')));
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function actorsOf(entry: Entry): string[] {
  const groups = attr(entry, 'candidateGroups')
    .split(',')
    .map((item) => item.trim());
  return [attr(entry, 'assignee').trim(), ...groups].filter((item, index, all) => item && all.indexOf(item) === index);
}

function describeElement(entry: Entry, tag: string, children: Entry[]): BpmnElement {
  const element: BpmnElement = { id: attr(entry, 'id'), type: tag, name: attr(entry, 'name') };
  if (tag === 'userTask') {
    element.actors = actorsOf(entry);
    element.boundaryTimer = null;
  } else if (tag === 'boundaryEvent') {
    element.attachedTo = attr(entry, 'attachedToRef');
    element.interrupting = attr(entry, 'cancelActivity') !== 'false';
    element.timer = timerOf(children);
    element.durationSeconds = durationSecondsOf(children);
  }
  return element;
}

function finishModel(model: BpmnModel): void {
  for (const element of model.elements) {
    model.counts[element.type] = (model.counts[element.type] ?? 0) + 1;
    if (element.type.endsWith('Gateway')) {
      element.outgoing = model.flows.filter((flow) => flow.from === element.id).length;
    }
  }
  for (const boundary of model.elements.filter((item) => item.type === 'boundaryEvent' && item.timer)) {
    const task = model.elements.find((item) => item.id === boundary.attachedTo && item.type === 'userTask');
    if (task) task.boundaryTimer = { timer: boundary.timer as string, durationSeconds: boundary.durationSeconds ?? null, interrupting: boundary.interrupting === true };
  }
}

function collect(entries: Entry[], model: BpmnModel): void {
  for (const entry of entries) {
    const tag = tagOf(entry);
    if (!tag) continue;
    const children = childrenOf(entry, tag);
    if (FLOW_NODES.has(tag)) {
      model.elements.push(describeElement(entry, tag, children));
      if (NESTED.has(tag)) collect(children, model);
    } else if (tag === 'sequenceFlow') {
      const condition = children.find((child) => tagOf(child) === 'conditionExpression');
      const conditionText = condition ? textOf(childrenOf(condition, 'conditionExpression')) : '';
      model.flows.push({
        id: attr(entry, 'id'),
        from: attr(entry, 'sourceRef'),
        to: attr(entry, 'targetRef'),
        condition: conditionText || null,
      });
    } else if (tag === 'participant') {
      model.participants.push({ id: attr(entry, 'id'), name: attr(entry, 'name'), process: attr(entry, 'processRef') || null });
    } else if (tag === 'lane') {
      const refs = children
        .filter((child) => tagOf(child) === 'flowNodeRef')
        .map((child) => textOf(childrenOf(child, 'flowNodeRef')));
      model.lanes.push({ id: attr(entry, 'id'), name: attr(entry, 'name'), elements: refs });
    } else if (['definitions', 'process', 'collaboration', 'laneSet', 'childLaneSet'].includes(tag)) {
      if (tag === 'process' && attr(entry, 'id')) model.processIds.push(attr(entry, 'id'));
      collect(children, model);
    }
  }
}

export function bpmnTypeOf(activityType: string): string {
  if (/EndEvent$/.test(activityType)) return 'endEvent';
  if (/^intermediate.*Throw/.test(activityType)) return 'intermediateThrowEvent';
  if (/^intermediate/.test(activityType)) return 'intermediateCatchEvent';
  if (/^boundary/.test(activityType)) return 'boundaryEvent';
  return activityType;
}

export function parseBpmn(xml: string): BpmnModel {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line } = validation.err;
    return emptyModel([`строка ${line}: ${msg}`]);
  }
  const root = parser.parse(xml) as Entry[];
  if (!root.some((entry) => tagOf(entry) === 'definitions')) {
    return emptyModel(['корневой элемент definitions не найден — это не BPMN-файл']);
  }
  const model: BpmnModel = { parsed: true, errors: [], processIds: [], counts: {}, elements: [], flows: [], participants: [], lanes: [] };
  collect(root, model);
  finishModel(model);
  return model;
}
