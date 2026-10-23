import { asArray, asRecord, failure, http, num, str } from './http';
import { ProbeError } from './errors';
import { executor, sleep, type ExecutorTable } from './types';
import { BANK_SBP_SCENARIO, bankIncident, type Incident } from './monitoring-bank';
import { missingFile, readWorkText } from './work';

const GRAFANA = 'http://grafana:3000';
const PROMETHEUS = 'http://prometheus:9090';
const DEMO_APP = 'http://demo-app:8200';
const AUTH = 'admin:admin';
const FOLDER_TITLE = 'Учебные правила';
const POLL_MS = 2000;
const RULE_INTERVAL_SEC = 10;

const grafana = (path: string, options: Parameters<typeof http>[2] = {}) =>
  http('Grafana', `${GRAFANA}${path}`, { basic: AUTH, ...options });
const prometheus = (path: string) => http('Prometheus', `${PROMETHEUS}${path}`);
const demoApp = (path: string, options: Parameters<typeof http>[2] = {}) => http('Учебное приложение', `${DEMO_APP}${path}`, options);

function panelsOf(items: unknown[]): Array<{ title: string; type: string; queries: string[] }> {
  const out: Array<{ title: string; type: string; queries: string[] }> = [];
  for (const item of items) {
    const panel = asRecord(item);
    const queries = asArray(panel.targets)
      .map((target) => str(asRecord(target).expr))
      .filter(Boolean);
    if (panel.type !== 'row') out.push({ title: str(panel.title), type: str(panel.type), queries });
    out.push(...panelsOf(asArray(panel.panels)));
  }
  return out;
}

async function listRules(): Promise<Array<Record<string, unknown>>> {
  const result = await grafana('/api/v1/provisioning/alert-rules');
  if (!result.ok) throw failure('Grafana', 'чтение правил', result);
  return asArray(result.json).map(asRecord);
}

async function ruleStates(): Promise<Map<string, string>> {
  const result = await grafana('/api/prometheus/grafana/api/v1/rules');
  const states = new Map<string, string>();
  const groups = asArray(asRecord(asRecord(result.json).data).groups);
  for (const group of groups) {
    for (const rule of asArray(asRecord(group).rules)) {
      const row = asRecord(rule);
      states.set(str(row.name), str(row.state));
    }
  }
  return states;
}

function stateName(raw: string | undefined): string {
  if (raw === 'firing') return 'Alerting';
  if (raw === 'pending') return 'Pending';
  return raw === 'inactive' || !raw ? 'Normal' : raw;
}

function durationText(value: unknown): string {
  if (typeof value === 'string') return value;
  const seconds = num(value) / 1e9;
  return seconds ? `${seconds}s` : '0s';
}

function ruleQueries(rule: Record<string, unknown>): string[] {
  return asArray(rule.data)
    .map((item) => str(asRecord(asRecord(item).model).expr))
    .filter(Boolean);
}

async function instantQuery(promql: string) {
  const result = await prometheus(`/api/v1/query?query=${encodeURIComponent(promql)}`);
  const body = asRecord(result.json);
  if (result.status === 400 || body.status === 'error') {
    return { series: 0, value: null, queryError: str(body.error, 'запрос не принят').slice(0, 300) };
  }
  if (!result.ok) throw failure('Prometheus', 'запрос', result);
  const vector = asArray(asRecord(body.data).result);
  const first = asRecord(vector[0]);
  const raw = asArray(first.value)[1];
  return { series: vector.length, value: raw === undefined ? null : Number(raw), queryError: null };
}

type QueryResult = { series: number; value: number | null; queryError: string | null };

const MAX_QUERIES = 20;

export async function queriesOfFile(text: string, run: (promql: string) => Promise<QueryResult> = instantQuery) {
  const lines = text.split('\n').map((row) => row.trim()).filter((row) => row && !row.startsWith('#'));
  if (lines.length > MAX_QUERIES) {
    return { series: 0, value: null, queryError: `слишком много запросов в файле: не больше ${MAX_QUERIES}`, queries: [] };
  }
  const whole = await run(text.trim());
  if (!whole.queryError || lines.length < 2) return { ...whole, queries: [{ query: text.trim(), ...whole }] };
  const queries = [];
  for (const query of lines) queries.push({ query, ...(await run(query)) });
  return { ...queries[0]!, queries };
}

async function findFolder(): Promise<string | null> {
  const existing = await grafana('/api/folders');
  const found = asArray(existing.json).map(asRecord).find((folder) => str(folder.title) === FOLDER_TITLE);
  return found ? str(found.uid) : null;
}

const MIN_DELETE_TITLE = 8;

export function rulesToDelete(rules: Array<Record<string, unknown>>, folderUid: string | null, titleContains: string) {
  if (!folderUid) return [];
  return rules.filter((rule) => str(rule.folderUID) === folderUid && str(rule.title).includes(titleContains));
}

async function ensureFolder(): Promise<string> {
  const existing = await findFolder();
  if (existing) return existing;
  const created = await grafana('/api/folders', { method: 'POST', json: { title: FOLDER_TITLE } });
  if (!created.ok) throw failure('Grafana', 'создание папки правил', created);
  return str(asRecord(created.json).uid);
}

async function watchRule(titleContains: string, seconds: number, deadlineStart: number): Promise<number | null> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const states = await ruleStates();
    for (const [name, state] of states) {
      if (name.includes(titleContains) && state === 'firing') return Math.round((Date.now() - deadlineStart) / 1000);
    }
    await sleep(POLL_MS);
  }
  return null;
}

function demoIncident(scenario: string, label: string, incidentSec: number): Incident {
  return {
    prepare: async () => {
      await demoApp('/scenario', { method: 'DELETE' });
    },
    begin: async () => {
      const launched = await demoApp('/scenario', {
        method: 'POST',
        json: { name: scenario, label, durationSec: Math.max(10, incidentSec) },
      });
      if (!launched.ok) throw failure('Учебное приложение', 'запуск сценария', launched);
    },
    end: async () => {
      await demoApp('/scenario', { method: 'DELETE' });
    },
    transfersSent: () => 0,
  };
}

export const MONITORING_EXECUTORS: ExecutorTable = {
  'grafana.dashboards': executor<{ titleContains: string }>(async ({ titleContains }) => {
    const found = await grafana(`/api/search?type=dash-db&query=${encodeURIComponent(titleContains)}`);
    if (!found.ok) throw failure('Grafana', 'поиск дашбордов', found);
    const dashboards = [];
    for (const item of asArray(found.json).map(asRecord)) {
      const detail = await grafana(`/api/dashboards/uid/${encodeURIComponent(str(item.uid))}`);
      const dashboard = asRecord(asRecord(detail.json).dashboard);
      dashboards.push({ title: str(dashboard.title), panels: panelsOf(asArray(dashboard.panels)) });
    }
    return { count: dashboards.length, dashboards };
  }),

  'grafana.alertRules': executor<{ titleContains?: string }>(async ({ titleContains }) => {
    const states = await ruleStates();
    const rules = (await listRules())
      .filter((rule) => !titleContains || str(rule.title).includes(titleContains))
      .map((rule) => ({
        title: str(rule.title),
        condition: str(rule.condition),
        for: durationText(rule.for),
        state: stateName(states.get(str(rule.title))),
        queries: ruleQueries(rule),
      }));
    return { count: rules.length, rules };
  }),

  'prometheus.query': executor<{ promql: string }>(async ({ promql }) => instantQuery(promql)),

  'prometheus.queryFile': executor<{ file: string }>(async ({ file }, ctx) => {
    const text = readWorkText(ctx, file);
    if (text === null) return { series: 0, value: null, queryError: missingFile(file), queries: [] };
    if (!text.trim()) return { series: 0, value: null, queryError: `файл work/${file} пуст`, queries: [] };
    return queriesOfFile(text);
  }),

  'monitoring.alertDrill': executor<{
    ruleTitleContains: string;
    scenario: string;
    calmSec: number;
    incidentSec: number;
    bankTime?: string;
  }>(async (params, ctx) => {
    const rules = (await listRules()).filter((rule) => str(rule.title).includes(params.ruleTitleContains));
    if (!rules.length) {
      return { ruleFound: false, firedInCalm: false, firedInIncident: false, firedAfterSec: null, transfersSent: 0 };
    }
    const incident =
      params.scenario === BANK_SBP_SCENARIO
        ? bankIncident(ctx, params.bankTime)
        : demoIncident(params.scenario, ctx.label, params.incidentSec);
    let calm: number | null;
    let fired: number | null;
    try {
      await incident.prepare();
      calm = await watchRule(params.ruleTitleContains, params.calmSec, Date.now());
      const started = Date.now();
      await incident.begin();
      fired = await watchRule(params.ruleTitleContains, params.incidentSec, started);
    } finally {
      await incident.end();
    }
    return {
      ruleFound: true,
      firedInCalm: calm !== null,
      firedInIncident: fired !== null,
      firedAfterSec: fired,
      transfersSent: incident.transfersSent(),
    };
  }),

  'monitoring.scenario': executor<{ name: string; durationSec: number }>(async (params, ctx) => {
    const result = await demoApp('/scenario', {
      method: 'POST',
      json: { name: params.name, label: ctx.label, durationSec: params.durationSec },
    });
    if (!result.ok) throw failure('Учебное приложение', 'запуск сценария', result);
    return { started: true };
  }),

  'grafana.importDashboard': executor<{ json: Record<string, unknown> }>(async ({ json }) => {
    const result = await grafana('/api/dashboards/db', {
      method: 'POST',
      json: { dashboard: { ...json, id: null }, overwrite: true },
    });
    if (!result.ok) throw failure('Grafana', 'загрузка дашборда', result);
    return { imported: true };
  }),

  'grafana.deleteAlertRules': executor<{ titleContains: string }>(async ({ titleContains }) => {
    if (titleContains.trim().length < MIN_DELETE_TITLE) {
      throw new ProbeError(`Название правила для удаления короче ${MIN_DELETE_TITLE} символов: так можно удалить чужое`);
    }
    const found = rulesToDelete(await listRules(), await findFolder(), titleContains);
    for (const rule of found) {
      const result = await grafana(`/api/v1/provisioning/alert-rules/${encodeURIComponent(str(rule.uid))}`, { method: 'DELETE' });
      if (!result.ok) throw failure('Grafana', 'удаление правила', result);
    }
    return { deleted: found.length };
  }),

  'grafana.createAlertRule': executor<{ rule: Record<string, unknown> }>(async ({ rule }, ctx) => {
    const folderUID = await ensureFolder();
    const group = str(rule.ruleGroup) || `kit-${ctx.label}`;
    const body = {
      title: group,
      interval: RULE_INTERVAL_SEC,
      rules: [
        {
          orgID: 1,
          noDataState: 'OK',
          execErrState: 'OK',
          isPaused: false,
          ...rule,
          folderUID,
          ruleGroup: group,
        },
      ],
    };
    const result = await grafana(
      `/api/v1/provisioning/folder/${encodeURIComponent(folderUID)}/rule-groups/${encodeURIComponent(group)}`,
      { method: 'PUT', json: body, headers: { 'X-Disable-Provenance': 'true' } },
    );
    if (!result.ok) throw failure('Grafana', 'создание правила', result);
    return { created: true };
  }),
};

