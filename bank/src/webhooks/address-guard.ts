export type AddressClass = 'LOOPBACK' | 'UNSPECIFIED' | 'LINK_LOCAL';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

export function parseIpv4(text: string): [number, number, number, number] | null {
  const match = IPV4.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts as [number, number, number, number];
}

function parseGroups(text: string): number[] | null {
  if (text === '') return [];
  const groups: number[] = [];
  const pieces = text.split(':');
  for (const [index, piece] of pieces.entries()) {
    const v4 = index === pieces.length - 1 ? parseIpv4(piece) : null;
    if (v4) {
      groups.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
    } else if (HEXTET.test(piece)) {
      groups.push(parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

export function parseIpv6(raw: string): number[] | null {
  const text = raw.replace(/^\[|\]$/g, '').split('%')[0] as string;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] as string);
  if (halves.length === 1) return head && head.length === 8 ? head : null;
  const tail = parseGroups(halves[1] as string);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function classifyIpv4(parts: readonly number[]): AddressClass | null {
  if (parts[0] === 127) return 'LOOPBACK';
  if (parts[0] === 0) return 'UNSPECIFIED';
  if (parts[0] === 169 && parts[1] === 254) return 'LINK_LOCAL';
  return null;
}

function embeddedIpv4(groups: readonly number[]): number[] {
  return [(groups[6] as number) >> 8, (groups[6] as number) & 255, (groups[7] as number) >> 8, (groups[7] as number) & 255];
}

function classifyIpv6(groups: readonly number[]): AddressClass | null {
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (zeros(8)) return 'UNSPECIFIED';
  if (zeros(7) && groups[7] === 1) return 'LOOPBACK';
  if (zeros(5) && groups[5] === 0xffff) return classifyIpv4(embeddedIpv4(groups));
  if (zeros(6)) return classifyIpv4(embeddedIpv4(groups));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return classifyIpv4(embeddedIpv4(groups));
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return 'LINK_LOCAL';
  return null;
}

export function classifyAddress(address: string): AddressClass | null {
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  return v6 ? classifyIpv6(v6) : null;
}
