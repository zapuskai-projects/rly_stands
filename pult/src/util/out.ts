const ESC = String.fromCharCode(27);

const COLORS_ON = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (code: number, text: string) => (COLORS_ON ? `${ESC}[${code}m${text}${ESC}[0m` : text);

export const color = {
  green: (text: string) => paint(32, text),
  red: (text: string) => paint(31, text),
  yellow: (text: string) => paint(33, text),
  dim: (text: string) => paint(2, text),
  bold: (text: string) => paint(1, text),
};

const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function write(text: string): void {
  process.stdout.write(text);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function errorLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

export const screen = {
  clear: () => write(`${ESC}[2J${ESC}[H`),
  hideCursor: () => write(`${ESC}[?25l`),
  showCursor: () => write(`${ESC}[?25h`),
};

export function padRight(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
}
