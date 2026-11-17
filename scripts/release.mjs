import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const versionFiles = ['VERSION', 'pult/package.json', 'pult/package-lock.json'];

export function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function nextVersion(current, tags) {
  if (!versionPattern.test(current)) throw new Error('Некорректная версия набора');
  const released = tags.filter((tag) => tag.startsWith('v') && versionPattern.test(tag.slice(1)))
    .map((tag) => tag.slice(1)).sort(compareVersions).at(-1);
  if (!released || compareVersions(current, released) > 0) return current;
  const [major, minor, patch] = released.split('.').map(Number);
  const next = [major, minor, patch + 1].join('.');
  if (!versionPattern.test(next)) throw new Error('Нужна новая минорная версия набора');
  return next;
}

export function canResumeRelease({ source, parent, subject, version, head, tag, files }) {
  return versionPattern.test(version) && parent === source && head === tag &&
    subject === `chore(kit): release ${version}` && files.every((file) => versionFiles.includes(file));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function output(values) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function prepare() {
  const source = process.env.GITHUB_SHA;
  if (!source || !process.env.GITHUB_OUTPUT) throw new Error('Выпуск запускается через GitHub Actions');
  git('fetch', 'origin', 'main', '--tags');
  const head = git('rev-parse', 'origin/main');
  if (head !== source) {
    const version = git('show', `${head}:VERSION`);
    const tag = git('tag', '--points-at', head).split('\n').includes(`v${version}`) ? head : '';
    const resume = canResumeRelease({
      source, head, tag, version,
      parent: git('rev-parse', `${head}^`),
      subject: git('log', '-1', '--format=%s', head),
      files: git('diff', '--name-only', source, head).split('\n').filter(Boolean),
    });
    if (!resume) { output({ publish: false }); return; }
    git('checkout', '--detach', head);
    output({ publish: true, build: false, version });
    return;
  }
  git('checkout', '--detach', source);
  const current = readFileSync('VERSION', 'utf8').trim();
  const version = nextVersion(current, git('tag', '--list', 'v*').split('\n'));
  const pkg = JSON.parse(readFileSync('pult/package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('pult/package-lock.json', 'utf8'));
  if (pkg.version !== current || lock.version !== current || lock.packages?.['']?.version !== current) {
    throw new Error('Версии VERSION, package.json и package-lock.json должны совпадать');
  }
  writeFileSync('VERSION', `${version}\n`);
  pkg.version = lock.version = lock.packages[''].version = version;
  writeFileSync('pult/package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync('pult/package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  git('add', '--', ...versionFiles);
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '--allow-empty', '-m', `chore(kit): release ${version}`);
  git('tag', `v${version}`);
  output({ publish: true, build: true, version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepare();
