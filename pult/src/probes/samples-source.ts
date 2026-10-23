import { ProbeError } from './errors';
import { asArray, asRecord, str } from './http';

export type SamplesFrom = { probe: string; path: string };
export type Sample = { data: unknown; expectValid: boolean };

const MAX_SAMPLES = 200;

export function pickPath(root: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const mapped = segment.endsWith('[]');
    const key = mapped ? segment.slice(0, -2) : segment;
    if (key) current = asRecord(current)[key];
    if (mapped) {
      const rest = segments.slice(index + 1).join('.');
      return asArray(current).map((item) => (rest ? pickPath(item, rest) : item));
    }
  }
  return current;
}

export function samplesFromObservation(observations: Record<string, unknown> | undefined, from: SamplesFrom): Sample[] {
  if (!observations || !(from.probe in observations)) {
    throw new ProbeError(`Образцы берутся из проверки ${from.probe}, а её результата нет: она должна стоять в списке раньше`);
  }
  const observed = observations[from.probe];
  const failed = asRecord(observed).error;
  if (typeof failed === 'string') throw new ProbeError(`Образцы из проверки ${from.probe} не получены: ${str(failed)}`);
  const picked = pickPath(observed, from.path);
  if (!Array.isArray(picked)) throw new ProbeError(`В результате проверки ${from.probe} по пути ${from.path} нет списка образцов`);
  return picked.slice(0, MAX_SAMPLES).map((data) => ({ data, expectValid: true }));
}

export function requiredMissing(sampleList: Sample[], required: unknown): string[] {
  const own = new Set(asArray(required).map(String));
  const objects = sampleList.filter((sample) => sample.expectValid).map((sample) => asRecord(sample.data));
  if (!objects.length) return [];
  const common = Object.keys(objects[0]!).filter((key) => objects.every((item) => key in item));
  return common.filter((key) => !own.has(key)).sort();
}
