import type { DefectMark } from './catalog';

export interface LimitDefectFlags {
  boundary: boolean;
  utcDay: boolean;
  templateSkip?: boolean;
}

export type LimitDecision = (flags: LimitDefectFlags) => string | null;

const ACCEPTED = 'ACCEPTED';

export function limitDefectMarks(decide: LimitDecision, active: LimitDefectFlags, context: Record<string, unknown>): DefectMark[] {
  const actual = decide(active) ?? ACCEPTED;
  const marks: DefectMark[] = [];
  const probes: [boolean, LimitDefectFlags, DefectMark['code']][] = [
    [active.boundary, { ...active, boundary: false }, 'limit-boundary'],
    [active.utcDay, { ...active, utcDay: false }, 'daily-limit-utc'],
    [active.templateSkip === true, { ...active, templateSkip: false }, 'template-skips-limit'],
  ];
  for (const [isActive, without, code] of probes) {
    if (!isActive) continue;
    const expected = decide(without) ?? ACCEPTED;
    if (expected !== actual) marks.push({ code, details: { expected, actual, ...context } });
  }
  return marks;
}
