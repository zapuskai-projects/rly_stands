type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const child of children) if (child || child === '') node.append(child);
  return node;
}

export function button(label: string, run: () => void | Promise<void>, style = '') {
  const node = element('button', 'button ' + style, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await run(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    finally { node.disabled = false; }
  });
  return node;
}

export function link(label: string, href: string | null | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const node = element('a', 'button', label);
    node.href = url.href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  } catch { return null; }
}

export const row = (...items: Child[]) => element('div', 'row', ...items);
export const card = (title: string, ...items: Child[]) => element('section', 'card', element('h2', '', title), ...items);
export const muted = (value: string) => element('p', 'sub', value);
export const badge = (value: string, tone = '') => element('span', 'badge ' + tone, value);
export const date = (value: string | number | null | undefined) => value ? new Date(value).toLocaleString('ru-RU') : '—';

export function notify(message: string, danger = false) {
  const area = document.querySelector<HTMLElement>('#notice')!;
  area.replaceChildren(row(element('span', '', message), button('Закрыть', () => area.replaceChildren())));
  area.className = danger ? 'notice bad' : 'notice info';
}

export function dialog(title: string, content: Node, actions: (close: () => void) => Child[]) {
  const previous = document.activeElement;
  const node = element('dialog', 'dialog');
  const close = () => node.close();
  const header = element('h2', '', title);
  header.id = 'dialog-heading';
  node.setAttribute('aria-labelledby', header.id);
  node.append(header, element('div', 'dialog-body', content), row(...actions(close), button('Закрыть', close)));
  node.addEventListener('close', () => {
    node.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, { once: true });
  document.body.append(node);
  node.showModal();
  return node;
}

export function pager(offset: number, total: number, size: number, move: (offset: number) => Promise<void>) {
  return row(offset > 0 && button('Назад', () => move(Math.max(0, offset - size))),
    muted(total ? `${offset + 1}–${Math.min(total, offset + size)} из ${total}` : 'Нет записей'),
    offset + size < total && button('Дальше', () => move(offset + size)));
}
