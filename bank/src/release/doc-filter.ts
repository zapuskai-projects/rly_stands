import { isRelease, releaseAtLeast, type Release } from './release';

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const MARK = /\s*\{release=([0-9.]+)\}\s*$/;
const NOTES_VERSION = /^([0-9]+\.[0-9]+)\.[0-9]+(\s|$)/;
const FENCE = /^\s*(```|~~~)/;

function headingRelease(title: string, implicitNotes: boolean): string | null {
  const marked = MARK.exec(title);
  if (marked) return marked[1] as string;
  return implicitNotes ? (NOTES_VERSION.exec(title)?.[1] ?? null) : null;
}

export function filterMarkdown(markdown: string, current: Release, releaseNotes = false): string {
  const output: string[] = [];
  let skipLevel: number | null = null;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      if (skipLevel !== null && level <= skipLevel) skipLevel = null;
      if (skipLevel === null) {
        const wanted = headingRelease(heading[2] as string, releaseNotes && level === 2);
        if (wanted !== null && !(isRelease(wanted) && releaseAtLeast(current, wanted))) {
          skipLevel = level;
          continue;
        }
        output.push(wanted === null ? line : line.replace(MARK, ''));
        continue;
      }
    }
    if (skipLevel === null) output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
