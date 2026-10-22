import { ProbeError } from './errors';
import { bpmnTypeOf, parseBpmn } from './bpmn';
import { asArray, asRecord, failure, http, str } from './http';
import { executor, sleep, type ExecutorTable } from './types';
import { readWorkText } from './work';

const MODULE = 'Camunda';
const BASE = 'http://operaton:8080/engine-rest';
const AUTH = 'demo:demo';
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 400;

const call = (path: string, options: Parameters<typeof http>[2] = {}) =>
  http(MODULE, `${BASE}${path}`, { basic: AUTH, ...options });

function typed(value: unknown): { value: unknown; type?: string } {
  if (typeof value === 'number') return { value, type: Number.isInteger(value) ? 'Long' : 'Double' };
  if (typeof value === 'boolean') return { value, type: 'Boolean' };
  if (typeof value === 'string') return { value, type: 'String' };
  return { value: JSON.stringify(value), type: 'Json' };
}

async function latestDefinition(key: string): Promise<Record<string, unknown> | null> {
  const result = await call(`/process-definition?key=${encodeURIComponent(key)}&latestVersion=true`);
  if (!result.ok) throw failure(MODULE, 'поиск процесса', result);
  return asArray(result.json).map(asRecord)[0] ?? null;
}

async function completeOpenTasks(instanceId: string): Promise<number> {
  const tasks = await call(`/task?processInstanceId=${instanceId}`);
  const open = asArray(tasks.json).map(asRecord);
  for (const task of open) {
    await call(`/task/${str(task.id)}/complete`, { method: 'POST', json: { variables: {} } });
  }
  return open.length;
}

async function instanceState(instanceId: string): Promise<string> {
  const result = await call(`/history/process-instance/${instanceId}`);
  return str(asRecord(result.json).state, 'ACTIVE');
}

async function readPath(instanceId: string) {
  const result = await call(
    `/history/activity-instance?processInstanceId=${instanceId}&sortBy=occurrence&sortOrder=asc&maxResults=200`,
  );
  return asArray(result.json)
    .map(asRecord)
    .filter((row) => str(row.activityType) !== 'multiInstanceBody')
    .map((row) => ({ id: str(row.activityId), type: bpmnTypeOf(str(row.activityType)), name: str(row.activityName) }));
}

async function readIncidents(instanceId: string) {
  const result = await call(`/incident?processInstanceId=${instanceId}`);
  return asArray(result.json)
    .map(asRecord)
    .map((row) => ({
      id: str(row.id),
      type: str(row.incidentType),
      activityId: str(row.activityId),
      message: str(row.incidentMessage),
    }));
}

const NOT_DEPLOYED = {
  started: false,
  ended: false,
  state: 'NOT_DEPLOYED',
  pathIds: [],
  pathNames: [],
  path: [],
  incidents: [],
};

export const CAMUNDA_EXECUTORS: ExecutorTable = {
  'camunda.process': executor<{ key: string }>(async ({ key }) => {
    const definition = await latestDefinition(key);
    if (!definition) return { exists: false, version: 0, elements: [] };
    const xml = await call(`/process-definition/${str(definition.id)}/xml`);
    if (!xml.ok) throw failure(MODULE, 'чтение схемы процесса', xml);
    const model = parseBpmn(str(asRecord(xml.json).bpmn20Xml));
    return { exists: true, version: Number(definition.version) || 1, elements: model.elements };
  }),

  'camunda.runPath': executor<{
    key: string;
    variables?: Record<string, unknown>;
    completeUserTasks?: boolean;
    waitMs?: number;
  }>(async (params, ctx) => {
    if (!(await latestDefinition(params.key))) return NOT_DEPLOYED;
    const variables = Object.fromEntries(Object.entries(params.variables ?? {}).map(([name, value]) => [name, typed(value)]));
    const started = await call(`/process-definition/key/${encodeURIComponent(params.key)}/start`, {
      method: 'POST',
      json: { businessKey: ctx.label, variables },
    });
    if (!started.ok) throw failure(MODULE, 'запуск процесса', started);
    const instanceId = str(asRecord(started.json).id);
    const deadline = Date.now() + (params.waitMs ?? DEFAULT_WAIT_MS);
    let state = await instanceState(instanceId);
    while (state === 'ACTIVE' && Date.now() < deadline) {
      if (params.completeUserTasks) await completeOpenTasks(instanceId);
      await sleep(POLL_MS);
      state = await instanceState(instanceId);
      if (state === 'ACTIVE' && (await readIncidents(instanceId)).length) break;
    }
    const path = await readPath(instanceId);
    const incidents = await readIncidents(instanceId);
    if (state === 'ACTIVE') {
      await call(`/process-instance/${instanceId}?skipCustomListeners=true&skipIoMappings=true`, { method: 'DELETE' });
    }
    return {
      started: true,
      ended: state !== 'ACTIVE',
      state,
      pathIds: path.map((item) => item.id),
      pathNames: path.map((item) => item.name),
      path,
      incidents,
    };
  }),

  'camunda.deploy': executor<{ file?: string; bpmnXml?: string }>(async (params, ctx) => {
    const xml = params.bpmnXml ?? (params.file ? readWorkText(ctx, params.file) : null);
    if (!xml) throw new ProbeError(params.file ? `Файл work/${params.file} не найден` : 'Нет BPMN для развёртывания');
    const form = new FormData();
    form.append('deployment-name', `kit-${ctx.label}`);
    form.append('enable-duplicate-filtering', 'false');
    form.append('deploy-changed-only', 'false');
    form.append('process.bpmn', new Blob([xml], { type: 'text/xml' }), 'process.bpmn');
    const result = await call('/deployment/create', { method: 'POST', body: form });
    if (!result.ok) throw failure(MODULE, 'развёртывание схемы', result);
    return { deployed: true };
  }),
};
