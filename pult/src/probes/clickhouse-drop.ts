export type ClickhouseTable = { name: string; engine: string; engineFull: string; createQuery: string };

const KAFKA_TOPICS = /kafka_topic_list\s*=\s*'([^']*)'/;

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}

function readsTopic(table: ClickhouseTable, topics: string[]): boolean {
  if (table.engine !== 'Kafka') return false;
  const listed = (KAFKA_TOPICS.exec(table.engineFull)?.[1] ?? '').split(',').map((topic) => topic.trim());
  return topics.some((topic) => listed.includes(topic));
}

export function tablesToDrop(all: ClickhouseTable[], names: string[], topics: string[]): string[] {
  const doomed = new Set(
    all.filter((table) => names.includes(table.name) || readsTopic(table, topics)).map((table) => table.name),
  );
  const views = all.filter((table) => table.engine === 'MaterializedView');
  for (let grew = true; grew; ) {
    grew = false;
    for (const view of views) {
      if (doomed.has(view.name)) continue;
      if ([...doomed].some((name) => mentions(view.createQuery, name))) {
        doomed.add(view.name);
        grew = true;
      }
    }
  }
  const isView = (name: string) => views.some((view) => view.name === name);
  return [...doomed].sort((a, b) => Number(isView(b)) - Number(isView(a)));
}
