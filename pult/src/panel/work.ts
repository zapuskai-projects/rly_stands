import { constants, closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Runtime } from '../config';
import { digest, secret } from './durable';
import { PanelError } from './errors';

const LIMIT = 1024 * 1024;
const fdPath = (fd: number): string => process.platform === 'linux' ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;

function segments(path: string): string[] {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new PanelError(400, 'WORK_PATH', 'Допустим только относительный путь внутри work');
  const parts = path.split('/');
  if (path.includes('\\') || parts.some((part) => !part || part.startsWith('.') || part === 'node_modules') || path.startsWith('/')) throw new PanelError(400, 'WORK_PATH', 'Допустим только относительный путь внутри work');
  return parts;
}

function pin(runtime: Runtime, relative: string): { fd: number; parent: number; name: string; verify: () => void; close: () => void } {
  const parts = segments(relative);
  if (process.platform !== 'linux') throw new PanelError(503, 'WORK_RUNTIME', 'Защищённый доступ к work требует запуска контроллера в контейнере Linux');
  const root = join(runtime.kitDir, 'work');
  if (realpathSync(root) !== resolve(root) || lstatSync(root).isSymbolicLink()) throw new PanelError(400, 'WORK_SYMLINK', 'Ссылки в work запрещены');
  const dirs: Array<{ fd: number; path: string }> = [];
  let fd: number | undefined;
  try {
    dirs.push({ fd: openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), path: root });
    for (const part of parts.slice(0, -1)) {
      const previous = dirs[dirs.length - 1]!;
      const path = join(previous.path, part);
      const child = openSync(`${fdPath(previous.fd)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      dirs.push({ fd: child, path });
    }
    const parent = dirs[dirs.length - 1]!;
    const name = parts[parts.length - 1]!;
    fd = openSync(`${fdPath(parent.fd)}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new PanelError(400, 'WORK_TYPE', 'Можно открыть только обычный файл');
    const file = fd;
    const verify = () => {
      for (const dir of dirs) if (!same(fstatSync(dir.fd), lstatSync(dir.path)) || realpathSync(dir.path) !== dir.path) throw new PanelError(409, 'WORK_CHANGED', 'Папка файла изменилась; перечитайте список');
      if (!same(fstatSync(file), lstatSync(join(parent.path, name)))) throw new PanelError(412, 'WORK_CHANGED', 'Файл изменился; перечитайте его или сохраните черновик');
    };
    verify();
    return { fd: file, parent: parent.fd, name, verify, close: () => { closeSync(file); dirs.reverse().forEach((dir) => closeSync(dir.fd)); } };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    dirs.reverse().forEach((dir) => closeSync(dir.fd));
    throw error;
  }
}

function bytesOf(fd: number): Buffer {
  if (fstatSync(fd).size > LIMIT) throw new PanelError(422, 'WORK_TOO_LARGE', 'Файл больше 1 MiB; откройте его во внешнем редакторе');
  const buffer = Buffer.allocUnsafe(LIMIT + 1);
  let length = 0;
  while (length < buffer.length) {
    const size = readSync(fd, buffer, length, buffer.length - length, length);
    if (!size) break;
    length += size;
  }
  const bytes = buffer.subarray(0, length);
  decodeWorkBytes(bytes);
  return bytes;
}

export function decodeWorkBytes(bytes: Buffer): string {
  if (bytes.length > LIMIT) throw new PanelError(422, 'WORK_TOO_LARGE', 'Файл больше 1 MiB');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new PanelError(422, 'WORK_BINARY', 'Файл не является текстом UTF-8; откройте его во внешнем редакторе'); }
  if (bytes.includes(0)) throw new PanelError(422, 'WORK_BINARY', 'Двоичный файл; откройте его во внешнем редакторе');
  return bytes.toString('utf8');
}

export function readWork(runtime: Runtime, path: string) {
  const file = pin(runtime, path);
  try {
    const bytes = bytesOf(file.fd); file.verify();
    return { path, hostPath: join(runtime.hostDir, 'work', path), text: bytes.toString('utf8'), etag: `"${digest(bytes)}"`, editable: true };
  } finally { file.close(); }
}

export function saveWork(runtime: Runtime, path: string, text: string, etag: string | undefined) {
  if (!etag) throw new PanelError(428, 'IF_MATCH_REQUIRED', 'Для сохранения нужен If-Match исходного файла');
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT || text.includes('\0')) throw new PanelError(422, 'WORK_TEXT', 'Текст должен быть UTF-8 и не больше 1 MiB');
  const file = pin(runtime, path);
  const temp = `${fdPath(file.parent)}/.panel-${secret()}`;
  let fd: number | undefined;
  try {
    const original = bytesOf(file.fd);
    if (etag !== `"${digest(original)}"`) throw new PanelError(412, 'WORK_CHANGED', 'Файл изменился; перечитайте его или сохраните черновик');
    const stat = fstatSync(file.fd);
    fd = openSync(temp, 'wx', stat.mode & 0o7777);
    writeFileSync(fd, text);
    fchownSync(fd, stat.uid, stat.gid); fchmodSync(fd, stat.mode & 0o7777); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    file.verify();
    const current = openSync(`${fdPath(file.parent)}/${file.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!same(stat, fstatSync(current)) || `"${digest(bytesOf(current))}"` !== etag) throw new PanelError(412, 'WORK_CHANGED', 'Файл изменился; перечитайте его или сохраните черновик'); } finally { closeSync(current); }
    renameSync(temp, `${fdPath(file.parent)}/${file.name}`); fsyncSync(file.parent);
    return { path, etag: `"${digest(Buffer.from(text))}"`, saved: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
    file.close();
  }
}

export function listWork(runtime: Runtime, offset = 0, limit = 50) {
  const root = join(runtime.kitDir, 'work');
  const files: Array<{ path: string; hostPath: string; size: number }> = [];
  if (process.platform !== 'linux') throw new PanelError(503, 'WORK_RUNTIME', 'Защищённый доступ к work требует запуска контроллера в контейнере Linux');
  if (realpathSync(root) !== resolve(root)) throw new PanelError(400, 'WORK_SYMLINK', 'Ссылки в work запрещены');
  const walk = (dir: string, fd: number) => {
    if (!same(fstatSync(fd), lstatSync(dir)) || realpathSync(dir) !== dir) throw new PanelError(409, 'WORK_CHANGED', 'Папка изменилась; перечитайте список');
    for (const entry of readdirSync(fdPath(fd), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (!full.startsWith(`${resolve(root)}${sep}`)) throw new PanelError(400, 'WORK_PATH', 'Путь вне work');
      if (entry.isDirectory()) {
        const child = openSync(`${fdPath(fd)}/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { walk(full, child); } finally { closeSync(child); }
      } else if (entry.isFile()) {
        const path = full.slice(root.length + 1);
        const file = pin(runtime, path);
        try { file.verify(); files.push({ path, hostPath: join(runtime.hostDir, 'work', path), size: fstatSync(file.fd).size }); } finally { file.close(); }
      }
    }
  };
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { walk(root, rootFd); } finally { closeSync(rootFd); }
  return { files: files.slice(offset, offset + limit), total: files.length, offset, limit, hostPath: join(runtime.hostDir, 'work'), name: basename(root) };
}
