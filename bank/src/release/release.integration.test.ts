import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { parseContract } from '../api/contract';
import { mountDocsContent } from '../api/docs-content';
import { mountDocs } from '../api/docs-ui';
import { errorHandler, notFoundHandler } from '../api/errors';
import { createRequestJournal, requestContext } from '../api/request-context';
import { registerOperations, type Handler } from '../api/router';
import { mountKit } from '../kit/routes';
import { KIT_TEST_SECRET, pick, startHarness, type ApiResponse, type Harness } from '../testing/harness';
import { PROBE_ASYNCAPI, PROBE_DOCUMENT, PROBE_OPENAPI } from '../testing/release-spec';
import { NOON_MOSCOW } from '../testing/scenarios';
import { databaseReleaseSource } from './release-source';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE = { label: 'release:run-1', defects: [], sbpMode: 'NORMAL', bankTime: null };

const handlers: Record<string, Handler> = {
  getPing: async () => ({ status: 200, body: { status: 'UP', later: 'yes' } }),
  getReleaseProbe: async () => ({ status: 200, body: { probe: 'ok' } }),
};

describe('релиз банка: маршрут, контракт, события и документы', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let server: Server;
  let docsDir: string;
  let base: string;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    docsDir = mkdtempSync(path.join(os.tmpdir(), 'bank-release-'));
    writeFileSync(path.join(docsDir, 'openapi.yaml'), PROBE_OPENAPI);
    writeFileSync(path.join(docsDir, 'asyncapi.yaml'), PROBE_ASYNCAPI);
    writeFileSync(path.join(docsDir, 'probe.md'), PROBE_DOCUMENT);
    const app = express();
    app.use(requestContext(h.clock, h.pool));
    const journal = createRequestJournal(h.pool, h.clock);
    app.use(journal.middleware);
    const releases = databaseReleaseSource(h.pool);
    mountDocs(app, releases, PROBE_OPENAPI);
    mountDocsContent(app, docsDir, releases);
    mountKit(app, { pool: h.pool, clock: h.clock, secret: KIT_TEST_SECRET, lookupRecipient: async () => null, journal });
    app.use(express.json());
    registerOperations(app, parseContract(PROBE_OPENAPI), handlers, { pool: h.pool, clock: h.clock }, releases);
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(docsDir, { recursive: true, force: true });
    await h.close();
  });

  const get = async (url: string) => fetch(`${base}${url}`);
  const scenario = async (body: Record<string, unknown>): Promise<number> =>
    (await fetch(`${base}/_kit/scenario`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kit-secret': KIT_TEST_SECRET }, body: JSON.stringify({ ...BASE, ...body }) })).status;

  it('на 1.0 проба следующего релиза отвечает как несуществующий маршрут и не видна в контракте, событиях и документах', async () => {
    assert.equal(await scenario({}), 200);
    const probe = await get('/api/v1/release-probe');
    assert.equal(probe.status, 404);
    assert.equal(((await probe.json()) as { code: string }).code, 'NOT_FOUND');
    const missing = await get('/api/v1/no-such-route');
    assert.equal(missing.status, 404);
    assert.equal((await get('/api/v1/ping')).status, 200);

    const contract = await (await get('/api/openapi.yaml')).text();
    assert.equal(contract.includes('release-probe'), false);
    assert.equal(contract.includes('ReleaseProbe'), false);
    const events = await (await get('/api/asyncapi.yaml')).text();
    assert.equal(events.includes('bank.probe.later'), false);
    assert.equal(events.includes('templateId'), false);
    const index = (await (await get('/docs-content')).json()) as { documents: { slug: string }[] };
    assert.deepEqual(index.documents.map((item) => item.slug), ['probe']);
    const document = (await (await get('/docs-content/probe')).json()) as { markdown: string };
    assert.equal(document.markdown.includes('Только с релиза 1.1'), false);
    assert.equal(document.markdown.includes('Старый раздел'), true);
  });

  it('на 1.1 проба отвечает, а контракт, события и документ её содержат', async () => {
    assert.equal(await scenario({ release: '1.1' }), 200);
    const probe = await get('/api/v1/release-probe');
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { probe: 'ok' });

    const contract = await (await get('/api/openapi.yaml')).text();
    assert.ok(contract.includes('/api/v1/release-probe'));
    const events = await (await get('/api/asyncapi.yaml')).text();
    assert.ok(events.includes('bank.probe.later'));
    assert.ok(events.includes('templateId'));
    const document = (await (await get('/docs-content/probe')).json()) as { markdown: string };
    assert.ok(document.markdown.includes('Только с релиза 1.1'));
  });

  it('сценарий без релиза и сброс возвращают 1.0, неизвестный релиз отвергается и ничего не меняет', async () => {
    assert.equal(await scenario({ release: '1.1' }), 200);
    assert.equal((await get('/api/v1/release-probe')).status, 200);
    assert.equal(await scenario({ release: '2.0' }), 400);
    assert.equal((await get('/api/v1/release-probe')).status, 200);
    assert.equal(await scenario({}), 200);
    assert.equal((await get('/api/v1/release-probe')).status, 404);
    assert.equal(await scenario({ release: '1.1' }), 200);
    const reset = await fetch(`${base}/_kit/reset`, { method: 'POST', headers: { 'x-kit-secret': KIT_TEST_SECRET } });
    assert.equal(reset.status, 200);
    assert.equal((await get('/api/v1/release-probe')).status, 404);
  });
});

describe('релиз банка в настоящем приложении', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
  });

  afterEach(async () => {
    await h.close();
  });

  const health = async (): Promise<ApiResponse> => h.api(null, 'GET', '/health');

  it('по умолчанию 1.0, сценарий переключает релиз, сброс возвращает 1.0', async () => {
    assert.equal(pick((await health()).body, 'release'), '1.0');
    const base = { label: 'release:run-2', defects: [], sbpMode: 'NORMAL', bankTime: null };
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...base, release: '1.1' })).status, 200);
    assert.equal(pick((await health()).body, 'release'), '1.1');
    assert.equal((await h.kit('POST', '/_kit/scenario', base)).status, 200);
    assert.equal(pick((await health()).body, 'release'), '1.0');
    await h.kit('POST', '/_kit/scenario', { ...base, release: '1.2' });
    assert.equal(pick((await health()).body, 'release'), '1.2');
    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    assert.equal(pick((await health()).body, 'release'), '1.0');
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...base, release: '3.0' })).status, 400);
  });

  it('на 1.0 в контракте и событиях банка нет пометок следующих релизов', async () => {
    for (const url of ['/api/openapi.yaml', '/api/asyncapi.yaml']) {
      const text = await (await fetch(`${h.baseUrl}${url}`)).text();
      assert.ok(text.length > 0);
      assert.equal(text.includes('x-release'), false, url);
    }
  });
});
