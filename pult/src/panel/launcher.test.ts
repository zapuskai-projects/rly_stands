import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('launcher проверяет fingerprint и loopback, повторный запуск открывает только новую вкладку', () => {
  const kit = realpathSync(resolve(__dirname, '../../..'));
  const dir = mkdtempSync(join(tmpdir(), 'panel-launcher-'));
  const log = join(dir, 'commands');
  const fake = join(dir, 'bin');
  mkdirSync(fake);
  writeFileSync(join(fake, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(fake, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$1:$2" in
  inspect:--format) case "$3" in *panel.path*) echo "$INSPECTED_FINGERPRINT";; *kit.controller*) echo 1;; *Running*) echo true;; esac ;;
  port:*) echo '127.0.0.1:18490' ;;
  exec:*) case "$*" in *bootstrap) echo TEST_NONCE;; *'bridge tick'*) echo "busy:$OWNER";; esac ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: fake + ':' + process.env.PATH, COMMAND_LOG: log, STAND_NO_BROWSER: '1', OWNER: String(process.pid), INSPECTED_FINGERPRINT: createHash('sha256').update(kit).digest('hex') };
  try {
    const run = (vars: typeof env) => spawnSync('sh', [join(kit, 'stand'), 'panel'], { env: vars, encoding: 'utf8', timeout: 10000 });
    const valid = run(env);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /127\.0\.0\.1:18490\/#bootstrap=TEST_NONCE/);
    const other = run({ ...env, INSPECTED_FINGERPRINT: 'other-kit' });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /другой папки/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /^(run|rm|stop|restart) /m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
