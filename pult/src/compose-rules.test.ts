import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { READINESS } from './modules/readiness';
import { isVersion } from './util/version';

const ROOT = resolve(__dirname, '../..');
const MIRROR = '${STAND_MIRROR:-ghcr.io/zapuskai-projects/mirror}/';

type Service = {
  image: string;
  profiles?: string[];
  labels?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  restart?: string;
};

type Compose = {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};

const compose = parse(readFileSync(resolve(ROOT, 'compose.yaml'), 'utf8')) as Compose;
const modules = Object.entries(compose.services).filter(([name]) => name !== 'kit-agent');

describe('compose.yaml набора', () => {
  it('все порты открыты только на 127.0.0.1', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      for (const port of service.ports ?? []) {
        assert.match(port, /^127\.0\.0\.1:\d+:\d+$/, `${name}: ${port}`);
      }
    }
  });

  it('тома — именованные или абсолютные, без относительных путей', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      for (const volume of service.volumes ?? []) {
        const source = volume.split(':')[0] ?? '';
        const named = source in compose.volumes;
        const absolute = source.startsWith('/') || source.startsWith('${KIT_HOST_DIR');
        assert.ok(named || absolute, `${name}: ${volume}`);
      }
    }
  });

  it('образы закреплены точным тегом, без latest', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.image.startsWith(MIRROR)) {
        const tag = service.image.slice(MIRROR.length).split(':')[1] ?? '';
        assert.ok(/\d/.test(tag) && tag !== 'latest', `${name}: ${service.image}`);
        continue;
      }
      assert.match(service.image, /stands-kit-(pult|linux|bank):\$\{KIT_VERSION/, name);
    }
  });

  it('сторонние образы — только из зеркала набора, каждый есть в списке зеркала', () => {
    const mirrored = new Set(
      readFileSync(resolve(ROOT, 'images/mirror.txt'), 'utf8')
        .split('\n')
        .filter((row) => row.trim() && !row.startsWith('#'))
        .map((row) => row.trim().split(/\s+/)[1]),
    );
    for (const [name, service] of Object.entries(compose.services)) {
      if (/stands-kit-(pult|linux|bank)/.test(service.image)) continue;
      assert.ok(service.image.startsWith(MIRROR), `${name}: ${service.image} не через зеркало`);
      assert.ok(mirrored.has(service.image.slice(MIRROR.length)), `${name}: нет в images/mirror.txt`);
    }
  });

  it('агент без профиля и с автоперезапуском', () => {
    const agent = compose.services['kit-agent'];
    assert.equal(agent?.profiles, undefined);
    assert.equal(agent?.restart, 'unless-stopped');
  });

  it('каждый модуль в одном профиле, метка совпадает, у профиля есть проверка готовности', () => {
    for (const [name, service] of modules) {
      assert.equal(service.profiles?.length, 1, name);
      const profile = service.profiles?.[0] ?? '';
      assert.equal(service.labels?.['stands.kit.module'], profile, name);
      assert.ok(profile in READINESS, `${name}: нет READINESS для ${profile}`);
    }
  });

  it('тома модулей помечены профилем для reset', () => {
    for (const [name, volume] of Object.entries(compose.volumes)) {
      if (name === 'stands-kit-data') continue;
      const labels = (volume as { labels?: Record<string, string> }).labels;
      assert.ok(labels?.['stands.kit.module'], name);
    }
  });
});

describe('VERSION', () => {
  it('корректная версия, совпадает с версией пакета пульта', () => {
    const version = readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim();
    const pack = JSON.parse(readFileSync(resolve(ROOT, 'pult/package.json'), 'utf8')) as { version: string };
    assert.equal(isVersion(version), true);
    assert.equal(pack.version, version);
  });
});
