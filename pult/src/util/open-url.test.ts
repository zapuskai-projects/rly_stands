import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Runtime } from '../config';
import { requestOpen } from './open-url';

describe('открыть адрес в браузере', () => {
  let kitDir: string;
  const saved = { opener: process.env.STAND_OPENER, off: process.env.STAND_NO_BROWSER };

  beforeEach(() => {
    kitDir = mkdtempSync(join(tmpdir(), 'kit-'));
    process.env.STAND_OPENER = '1';
    delete process.env.STAND_NO_BROWSER;
  });
  afterEach(() => {
    rmSync(kitDir, { recursive: true, force: true });
    if (saved.opener === undefined) delete process.env.STAND_OPENER;
    else process.env.STAND_OPENER = saved.opener;
    if (saved.off === undefined) delete process.env.STAND_NO_BROWSER;
    else process.env.STAND_NO_BROWSER = saved.off;
  });

  const runtime = () => ({ kitDir }) as Runtime;

  it('дописывает адрес в .stand/open, когда скрипт следит за ним', () => {
    mkdirSync(join(kitDir, '.stand'));
    assert.equal(requestOpen(runtime(), 'http://localhost:18100'), true);
    assert.equal(requestOpen(runtime(), 'https://edu.example.com/kit/connect?code=KX7M-P2QD'), true);
    assert.equal(
      readFileSync(join(kitDir, '.stand', 'open'), 'utf8'),
      'http://localhost:18100\nhttps://edu.example.com/kit/connect?code=KX7M-P2QD\n',
    );
  });

  it('молчит без наблюдателя, при STAND_NO_BROWSER=1 и для не-веб адресов', () => {
    assert.equal(requestOpen(runtime(), 'http://localhost:18100'), false);
    mkdirSync(join(kitDir, '.stand'));
    assert.equal(requestOpen(runtime(), 'file:///etc/passwd'), false);
    assert.equal(requestOpen(runtime(), 'https://a.example\nhttps://b.example'), false);
    process.env.STAND_NO_BROWSER = '1';
    assert.equal(requestOpen(runtime(), 'http://localhost:18100'), false);
    process.env.STAND_NO_BROWSER = '0';
    process.env.STAND_OPENER = '0';
    assert.equal(requestOpen(runtime(), 'http://localhost:18100'), false);
    assert.equal(existsSync(join(kitDir, '.stand', 'open')), false);
  });
});
