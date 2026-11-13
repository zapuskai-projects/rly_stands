import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const input = 'dist/panel-modules';
const output = 'dist/panel-web';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const files = new Map();

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
function publish(name, contents) {
  const file = name.replace(/\.(js|css)$/, '.' + hash(contents) + '.$1');
  writeFileSync(join(output, file), contents);
  return file;
}
function bundle(name) {
  if (files.has(name)) return files.get(name);
  const source = readFileSync(join(input, name), 'utf8');
  const compiled = source.replace(/(from\s+['"]\.\/)([\w-]+\.js)(['"])/g, (_full, prefix, dependency, suffix) => prefix + bundle(dependency) + suffix);
  const result = publish(name, compiled);
  files.set(name, result);
  return result;
}

const js = bundle('main.js');
const css = publish('panel.css', readFileSync('web/panel.css', 'utf8'));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const template = readFileSync('web/index.html', 'utf8');
const uiBuildId = version + '-' + hash(js + css + template);
writeFileSync(join(output, 'index.html'), template.replace('__BUILD__', uiBuildId).replace('__JS__', js).replace('__CSS__', css));
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ uiBuildId, apiProtocolVersion: 1 }));

