import { api, ApiError, session } from './api.js';
import { button, card, dialog, element, muted, notify, pager, row } from './dom.js';

type FileEntry = { path: string; size: number; hostPath: string };
type Listing = { files: FileEntry[]; total: number; offset: number; limit: number; hostPath: string };
type OpenFile = { path: string; text: string; etag: string; hostPath: string };
let current: OpenFile | null = null;
let draft = '';
let offset = 0;

export const dirty = () => current !== null && draft !== current.text;

export async function save() {
  if (!current || !dirty()) return;
  const file = current;
  const text = draft;
  const result = await api<{ etag: string }>('/api/work/file?path=' + encodeURIComponent(file.path), {
    method: 'PUT', headers: { 'If-Match': file.etag }, body: { path: file.path, text },
  });
  if (current === file) { file.etag = result.etag; file.text = text; }
  notify('Изменения сохранены в ' + file.path);
}

export function download() {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
  const anchor = element('a');
  anchor.href = url;
  anchor.download = current.path.split('/').at(-1) ?? 'черновик.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function leave(action: () => void | Promise<void>) {
  if (!dirty()) { await action(); return; }
  dialog('В файле есть несохранённые изменения', muted(current!.path), (close) => [
    !session.stale && button('Сохранить и продолжить', async () => { await save(); if (!dirty()) { close(); await action(); } }, 'primary'),
    button('Скачать черновик и продолжить', async () => { download(); draft = current!.text; close(); await action(); }),
  ]);
}

export async function files(area: HTMLElement) {
  const paint = async (page = offset) => {
    const listing = await api<Listing>('/api/work?offset=' + page + '&limit=25');
    if (!area.isConnected) return;
    offset = listing.offset;
    const editor = element('section');
    const open = async (path: string) => {
      let file: OpenFile;
      try { file = await api<OpenFile>('/api/work/file?path=' + encodeURIComponent(path)); }
      catch (error) {
        if (error instanceof ApiError && [413, 415, 422].includes(error.status)) {
          const localPath = listing.files.find((entry) => entry.path === path)?.hostPath ?? path;
          dialog('Откройте файл во внешнем редакторе', element('div', 'stack', muted(error.message), element('code', '', localPath)), () => []);
          return;
        }
        throw error;
      }
      current = file;
      draft = file.text;
      draw();
    };
    const draw = () => {
      editor.replaceChildren();
      if (!current) return;
      const text = element('textarea', 'editor');
      text.setAttribute('aria-label', 'Содержимое ' + current.path);
      text.spellcheck = false;
      text.value = draft;
      const indicator = muted(dirty() ? 'Есть несохранённые изменения' : 'Файл сохранён');
      text.oninput = () => { draft = text.value; indicator.textContent = dirty() ? 'Есть несохранённые изменения' : 'Файл сохранён'; };
      const persist = async () => {
        try { await save(); indicator.textContent = dirty() ? 'Есть несохранённые изменения' : 'Файл сохранён'; }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 412) throw error;
          dialog('Файл изменился на диске', muted('Можно сохранить свой черновик отдельно или перечитать текущую версию файла.'), (close) => [
            button('Скачать черновик', download),
            button('Перечитать с диска', async () => { await open(current!.path); close(); }),
          ]);
        }
      };
      editor.append(card(current.path, muted(current.hostPath), text, indicator,
        row(button('Сохранить', persist, 'primary'), button('Скачать черновик', download))));
    };
    const list = element('div', 'file-list');
    for (const f of listing.files) list.append(row(button(f.path, () => leave(() => open(f.path))), muted(f.size + ' Б')));
    area.replaceChildren(element('h1', '', 'Мои файлы'), card('Рабочая папка', muted(listing.hostPath),
      listing.total ? list : muted('Здесь появятся файлы, когда вы сохраните их в рабочей папке.'),
      pager(offset, listing.total, listing.limit, paint), button('Обновить список', () => paint())), editor);
    draw();
  };
  await paint();
}

window.addEventListener('beforeunload', (event) => {
  if (dirty()) { event.preventDefault(); event.returnValue = ''; }
});
