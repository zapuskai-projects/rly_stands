export function pullTracker(report: (text: string) => void): (line: string) => void {
  let total = 0;
  let done = 0;
  return (line) => {
    if (/Pulling fs layer/.test(line)) total += 1;
    else if (/Pull complete|Already exists/.test(line)) done += 1;
    else return;
    report(`  загружено частей: ${done} из ${total}`);
  };
}
