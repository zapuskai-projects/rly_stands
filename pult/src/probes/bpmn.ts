import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type BpmnElement = { id: string; type: string; name: string };
export type BpmnFlow = { id: string; from: string; to: string; condition: string | null };
export type BpmnParticipant = { id: string; name: string; process: string | null };
export type BpmnLane = { id: string; name: string; elements: string[] };

export type BpmnModel = {
  parsed: boolean;
  errors: string[];
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

function collect(entries: Entry[], model: BpmnModel): void {
  for (const entry of entries) {
    const tag = tagOf(entry);
    if (!tag) continue;
    const children = childrenOf(entry, tag);
    if (FLOW_NODES.has(tag)) {
      model.elements.push({ id: attr(entry, 'id'), type: tag, name: attr(entry, 'name') });
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
  const model: BpmnModel = { parsed: true, errors: [], elements: [], flows: [], participants: [], lanes: [] };
  collect(root, model);
  return model;
}
