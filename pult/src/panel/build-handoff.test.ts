import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadRuntime } from '../config';
import { mintBootstrap, bootstrap } from './auth';
import { Controller } from './controller';
import { bridge } from './handoff';

test('обновлённый checkout заменяет сборку, тот же журнал и вход доступны в V2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-update-'));
  const source = resolve(__dirname, '../..');
  const output = join(dir, 'dist/panel-web');
  const build = (version: string, title: string) => {
    writeFileSync(join(dir, 'VERSION'), version);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(dir, 'dist/panel-modules/main.js'), "import {title} from './content.js'; document.title = title;");
    writeFileSync(join(dir, 'dist/panel-modules/content.js'), 'export const title = ' + JSON.stringify(title) + ';');
    execFileSync(process.execPath, [join(source, 'scripts/build-panel.mjs')], { cwd: dir });
    const asset = readFileSync(join(output, 'index.html'), 'utf8').match(/src="\/([^"]+\.js)"/)![1]!;
    const dependency = readFileSync(join(output, asset), 'utf8').match(/from '\.\/([^']+)'/)![1]!;
    assert.ok(readFileSync(join(output, dependency), 'utf8').includes(title));
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as { uiBuildId: string };
    const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_VERSION: version });
    return { asset, controller: new Controller(runtime, manifest.uiBuildId) };
  };
  try {
    mkdirSync(join(dir, 'dist/panel-modules'), { recursive: true });
    cpSync(join(source, 'web'), join(dir, 'web'), { recursive: true });
    const first = build('1.0.0', 'Первый интерфейс');
    const user = bootstrap(first.controller.store, mintBootstrap(first.controller.store));
    writeFileSync(join(dir, 'VERSION'), '1.0.1');
    const claim = await bridge(first.controller, { verb: 'tick', pid: '1' });
    const [id, version] = claim.value.split(' ');
    assert.ok(id); assert.equal(version, '1.0.1');
    const second = build(version, 'Изменённый интерфейс');
    assert.notEqual(second.asset, first.asset);
    assert.notEqual(second.controller.uiBuildId, first.controller.uiBuildId);
    assert.equal(second.controller.store.state.sessions[0]?.id, user.id);
    assert.deepEqual(await bridge(second.controller, { verb: 'complete', pid: '1', id, version }), { value: 'complete' });
    assert.equal(second.controller.get(id).state, 'SUCCEEDED');
    assert.deepEqual(await bridge(second.controller, { verb: 'tick', pid: '1' }), { value: 'idle' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
