import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { probe, waitReady } from './readiness';

describe('waitReady', () => {
  it('пропускает проверку, пока нет нужного файла, и не считает это сбоем', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-'));
    const reports = await waitReady(
      [{ label: 'Prism', url: 'http://127.0.0.1:1/', timeoutSec: 1, needsFile: 'work/openapi.yaml' }],
      dir,
      () => undefined,
    );
    assert.deepEqual(reports, [{ label: 'Prism', ok: true, seconds: 0, skipped: 'work/openapi.yaml' }]);
  });

  it('проверяет готовность по HTTP, когда файл на месте', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-'));
    mkdirSync(join(dir, 'work'));
    writeFileSync(join(dir, 'work', 'openapi.yaml'), 'openapi: 3.0.3');
    const server = createServer((_request, response) => response.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const reports = await waitReady(
        [{ label: 'Prism', url: `http://127.0.0.1:${port}/`, timeoutSec: 5, needsFile: 'work/openapi.yaml' }],
        dir,
        () => undefined,
      );
      assert.equal(reports[0]?.ok, true);
      assert.equal(reports[0]?.skipped, undefined);
    } finally {
      server.close();
    }
  });

  it('ошибка сервера 5xx и закрытый порт — не готово', async () => {
    const server = createServer((_request, response) => response.writeHead(503).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      assert.equal(await probe({ label: 'x', url: `http://127.0.0.1:${port}/`, timeoutSec: 1 }), false);
      assert.equal(await probe({ label: 'y', tcp: { host: '127.0.0.1', port: 1 }, timeoutSec: 1 }), false);
    } finally {
      server.close();
    }
  });
});
