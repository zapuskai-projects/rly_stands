export function sourceLines(source: string): string[] {
  const withoutBlockComments = source.replace(/\/'[\s\S]*?'\//g, '');
  return withoutBlockComments
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith("'") && !/^@(start|end)\w*/i.test(row));
}

export function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    if (char === ',' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map(unquote);
}
