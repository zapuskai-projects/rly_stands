import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DIAGRAM_EXECUTORS } from './diagrams';
import type { ProbeContext } from './types';
import { missingFile, richTextProblem } from './work';

const dirs: string[] = [];
function workWith(files: Record<string, string>): ProbeContext {
  const workDir = mkdtempSync(join(tmpdir(), 'work-'));
  dirs.push(workDir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(workDir, name), content);
  return { workDir, hostWorkDir: '/Users/julia/rly_stands/work', label: 'l' };
}

describe('файла нет: пульт объясняет, где ищет и что рядом', () => {
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('Mac дописал расширение — пульт называет найденный файл и как переименовать', () => {
    const text = missingFile('payment-status.puml', workWith({ 'payment-status.puml.txt': '@startuml' }));
    assert.match(text, /есть payment-status\.puml\.txt/);
    assert.match(text, /Переименуйте файл ровно в payment-status\.puml/);
  });

  it('имя отличается регистром — тоже подсказывает', () => {
    assert.match(missingFile('payment-status.puml', workWith({ 'Payment-Status.puml': 'x' })), /есть Payment-Status\.puml/);
  });

  it('папка пустая — пульт пишет полный путь на компьютере студента', () => {
    const text = missingFile('payment-status.puml', workWith({}));
    assert.match(text, /\/Users\/julia\/rly_stands\/work — она пустая/);
  });

  it('рядом другие файлы — перечисляет их', () => {
    const text = missingFile('payment-status.puml', workWith({ 'diagram.puml': 'x', 'notes.md': 'y' }));
    assert.match(text, /сейчас в ней: diagram\.puml, notes\.md/);
  });

  it('без контекста — прежняя короткая подсказка', () => {
    assert.match(missingFile('a.puml'), /в папке work набора \(rly_stands\/work\)/);
  });

  it('файл в RTF из TextEdit — диаграмма не разбирается с понятной причиной, без запроса к серверу', async () => {
    assert.equal(richTextProblem('@startuml\n@enduml', 'a.puml'), null);
    const ctx = workWith({ 'payment-status.puml': '{\\rtf1\\ansi\\ansicpg1251 @startuml}' });
    const facts = (await DIAGRAM_EXECUTORS['plantuml.state']!({ file: 'payment-status.puml' }, ctx)) as { syntaxErrors: string[]; states: unknown[] };
    assert.match(facts.syntaxErrors[0] ?? '', /форматированный текст \(RTF\)/);
    assert.deepEqual(facts.states, []);
  });
});
