import { errorText } from './errors';
import { asArray, asRecord, failure, http, num, str } from './http';
import { executor, type ExecutorTable } from './types';
import { readWorkText } from './work';

const MODULE = 'Elasticsearch';
const BASE = 'http://elasticsearch:9200';
const FIRST_IDS = 20;

function rejectionReason(body: unknown): string {
  const error = asRecord(asRecord(body).error);
  const cause = asRecord(asArray(error.root_cause)[0]);
  return str(cause.reason) || str(error.reason) || 'запрос не принят';
}

const call = (path: string, options: Parameters<typeof http>[2] = {}) => http(MODULE, `${BASE}${path}`, options);

function flattenFields(properties: Record<string, unknown>, prefix = ''): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const [name, definition] of Object.entries(properties)) {
    const body = asRecord(definition);
    const full = `${prefix}${name}`;
    if (body.type !== undefined) out.push({ name: full, type: str(body.type) });
    const nested = asRecord(body.properties);
    if (Object.keys(nested).length) out.push(...flattenFields(nested, `${full}.`));
    const multi = asRecord(body.fields);
    if (Object.keys(multi).length) out.push(...flattenFields(multi, `${full}.`));
  }
  return out;
}

export const ELASTICSEARCH_EXECUTORS: ExecutorTable = {
  'elasticsearch.index': executor<{ name: string }>(async ({ name }) => {
    const index = encodeURIComponent(name);
    const info = await call(`/${index}`);
    if (info.status === 404) return { exists: false, shards: 0, replicas: 0, docs: 0, fields: [] };
    if (!info.ok) throw failure(MODULE, 'чтение индекса', info);
    const body = asRecord(Object.values(asRecord(info.json))[0]);
    const settings = asRecord(asRecord(body.settings).index);
    const count = await call(`/${index}/_count`);
    return {
      exists: true,
      shards: num(settings.number_of_shards),
      replicas: num(settings.number_of_replicas),
      docs: num(asRecord(count.json).count),
      fields: flattenFields(asRecord(asRecord(body.mappings).properties)),
    };
  }),

  'elasticsearch.search': executor<{ index: string; query?: Record<string, unknown>; queryFile?: string }>(
    async (params, ctx) => {
      let body: Record<string, unknown> = params.query ?? {};
      if (params.queryFile) {
        const text = readWorkText(ctx, params.queryFile);
        if (text === null) {
          return { total: 0, ids: [], queryError: `файла work/${params.queryFile} нет` };
        }
        try {
          body = asRecord(JSON.parse(text));
        } catch (error) {
          return { total: 0, ids: [], queryError: `файл work/${params.queryFile} — не JSON: ${errorText(error)}` };
        }
      }
      const result = await call(`/${encodeURIComponent(params.index)}/_search`, {
        method: 'POST',
        json: { size: FIRST_IDS, track_total_hits: true, ...body },
      });
      if (result.status === 404) return { total: 0, ids: [], queryError: `индекса ${params.index} нет` };
      if (result.status === 400) {
        return { total: 0, ids: [], queryError: rejectionReason(result.json) };
      }
      if (!result.ok) throw failure(MODULE, 'поиск', result);
      const hits = asRecord(asRecord(result.json).hits);
      const total = asRecord(hits.total);
      return {
        total: num(total.value ?? hits.total),
        ids: asArray(hits.hits).slice(0, FIRST_IDS).map((hit) => str(asRecord(hit)._id)),
        queryError: null,
      };
    },
  ),

  'elasticsearch.createIndex': executor<{ name: string; mappings?: Record<string, unknown>; settings?: Record<string, unknown> }>(
    async ({ name, mappings, settings }) => {
      const result = await call(`/${encodeURIComponent(name)}`, {
        method: 'PUT',
        json: { ...(mappings ? { mappings } : {}), ...(settings ? { settings } : {}) },
      });
      if (result.status === 400 && result.text.includes('resource_already_exists')) return { created: false };
      if (!result.ok) throw failure(MODULE, 'создание индекса', result);
      return { created: true };
    },
  ),

  'elasticsearch.bulk': executor<{ index: string; docs: Array<Record<string, unknown>> }>(async ({ index, docs }) => {
    const lines = docs.flatMap((doc) => {
      const { _id: id, ...source } = doc;
      return [JSON.stringify({ index: { _index: index, ...(id === undefined ? {} : { _id: String(id) }) } }), JSON.stringify(source)];
    });
    const result = await call('/_bulk?refresh=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: `${lines.join('\n')}\n`,
    });
    if (!result.ok || asRecord(result.json).errors === true) throw failure(MODULE, 'загрузка документов', result);
    return { indexed: docs.length };
  }),
};

