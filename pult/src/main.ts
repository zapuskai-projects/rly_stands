import { loadRuntime } from './config';
import { runCli } from './cli/commands';
import { runDemoApp } from './demo-app/server';
import { errorLine } from './util/out';

const argv = process.argv.slice(2);

if (argv[0] === 'demo-app') {
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
