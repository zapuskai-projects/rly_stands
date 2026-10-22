import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { OPENAPI_PATH } from '../config';
import { loadContract } from './contract';
import { mountDocs } from './docs-ui';

describe('документация API: Swagger UI и файл контракта', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    mountDocs(app, loadContract(OPENAPI_PATH));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('файл контракта отдаётся как YAML и совпадает с файлом на диске', async () => {
    const response = await fetch(`${base}/api/openapi.yaml`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /yaml/);
    const text = await response.text();
    assert.match(text, /^openapi: 3\./);
    assert.ok(text.includes('operationId: getHealth'));
  });

  it('страница Swagger UI открывается, называется «ЗапускБанк API» и подтягивает статику', async () => {
    const page = await fetch(`${base}/api/docs/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /swagger-ui/i);
    assert.ok(html.includes('ЗапускБанк API'));
    const asset = await fetch(`${base}/api/docs/swagger-ui-bundle.js`);
    assert.equal(asset.status, 200);
  });

  it('на служебные пути документации ничего лишнего не отдаётся', async () => {
    assert.equal((await fetch(`${base}/api/kit-api.yaml`)).status, 404);
    assert.equal((await fetch(`${base}/kit-api.yaml`)).status, 404);
  });
});
