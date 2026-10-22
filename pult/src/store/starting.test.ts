import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { clearStarting, markStarting, startingProfiles, STARTING_FRESH_MS } from './starting';

let dir = '';
const NOW = Date.parse('2026-10-20T12:00:00Z');

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kit-starting-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('метки запускаемых стендов', () => {
  it('без файла запускаемых нет', () => {
    assert.deepEqual(startingProfiles(join(dir, 'empty'), NOW), []);
  });

  it('метка видна, пока свежая, и пропадает по сроку', () => {
    markStarting(dir, 'bank', NOW);
    assert.deepEqual(startingProfiles(dir, NOW + 60_000), ['bank']);
    assert.deepEqual(startingProfiles(dir, NOW + STARTING_FRESH_MS + 1), []);
  });

  it('несколько стендов отмечаются независимо, снятие одной метки не трогает другую', () => {
    markStarting(dir, 'bank', NOW);
    markStarting(dir, 'monitoring', NOW);
    clearStarting(dir, 'bank');
    assert.deepEqual(startingProfiles(dir, NOW), ['monitoring']);
    clearStarting(dir, 'monitoring');
    assert.deepEqual(startingProfiles(dir, NOW), []);
  });

  it('снятие метки, которой нет, не падает', () => {
    clearStarting(dir, 'absent');
    assert.deepEqual(startingProfiles(dir, NOW), []);
  });
});
