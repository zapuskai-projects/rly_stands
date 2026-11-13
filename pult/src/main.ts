import { loadRuntime } from './config';
import { runCli } from './cli/commands';
import { runDemoApp } from './demo-app/server';
import { errorLine } from './util/out';
import { panelCommand } from './panel/commands';

const argv = process.argv.slice(2);

if (argv[0] === 'panel') {
  panelCommand(loadRuntime(), argv.slice(1)).catch((error: unknown) => { errorLine(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
} else if (argv[0] === 'demo-app') {
  runDemoApp();
} else {
  runCli(loadRuntime(), argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      errorLine(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
