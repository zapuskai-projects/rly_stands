export const SYSTEM_GROUPS: readonly string[] = ['bank-core-decisions', 'bank-antifraud'];
export const PULT_GROUP_PREFIX = 'kit-pult-';

export type GroupRow = {
  groupId: string;
  state: string;
  members: number;
  partitionsCommitted: number;
  committedTotal: number;
  otherTopicsCommitted: number;
};

export function isProtectedGroup(groupId: string): boolean {
  return SYSTEM_GROUPS.includes(groupId) || groupId.startsWith(PULT_GROUP_PREFIX);
}

export function studentGroupIds(all: string[], exclude: string[] = []): string[] {
  const skipped = new Set([...SYSTEM_GROUPS, ...exclude]);
  return [...new Set(all)].filter((id) => id && !skipped.has(id) && !isProtectedGroup(id)).sort();
}

export function committedOf(partitions: Array<{ partition: number; offset: string }>) {
  const offsets = partitions.map((item) => Number(item.offset)).filter((offset) => Number.isFinite(offset) && offset >= 0);
  return { partitionsCommitted: offsets.length, committedTotal: offsets.reduce((sum, offset) => sum + offset, 0) };
}

export function readersFacts(topic: string, rows: GroupRow[]) {
  const readers = rows.filter((row) => row.committedTotal > 0).sort((a, b) => a.groupId.localeCompare(b.groupId));
  return { topic, count: readers.length, groupIds: readers.map((row) => row.groupId), groups: readers };
}

export function deletableGroups(rows: GroupRow[]): { deletable: string[]; skipped: string[] } {
  const free = (row: GroupRow) => row.members === 0 && row.otherTopicsCommitted === 0 && !isProtectedGroup(row.groupId);
  return {
    deletable: rows.filter(free).map((row) => row.groupId),
    skipped: rows.filter((row) => !free(row)).map((row) => row.groupId),
  };
}
