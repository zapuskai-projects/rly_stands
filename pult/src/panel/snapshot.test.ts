import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { observedModule, taskAccepted } from './snapshot';

const postgres = { key: 'pg', profile: 'postgres', title: 'PostgreSQL', allowed: true, reason: null, requires: [], uis: [], minMemoryMb: 10 } satisfies SessionModule;
const bank = { ...postgres, key: 'bank', profile: 'bank', title: 'Банк', requires: [postgres.key] };
const session: Session = { user: { name: 'Ученик' }, token: { expiresAt: '2099-01-01' }, kit: { minVersion: '1.0', latestVersion: '1.0', offlineGraceHours: 24 }, tasks: [], modules: [postgres, bank] };

test('a running module with stopped or missing dependencies is partial with an explanation', () => {
  const own = { name: 'bank', profile: 'bank', running: true };
  const partial = observedModule(bank, session, [own, { name: 'pg', profile: 'postgres', running: false }]);
  assert.equal(partial.state, 'partial'); assert.match(partial.stateReason!, /PostgreSQL/);
  assert.equal(observedModule(bank, session, [own, { name: 'pg', profile: 'postgres', running: true }]).state, 'running');
  assert.equal(observedModule(bank, session, null).state, 'unknown');
  assert.equal(observedModule(bank, session, []).state, 'stopped');
  assert.match(observedModule(bank, { ...session, modules: [bank] }, [own]).stateReason!, /pg/);
});

test('standalone PASSED is accepted; project acceptance comes from project DONE independently of the last check', () => {
  assert.equal(taskAccepted({ status: 'PASSED', project: null } as SessionTask), true);
  assert.equal(taskAccepted({ status: 'FAILED', project: null } as SessionTask), false);
  assert.equal(taskAccepted({ status: 'FAILED', project: { state: 'DONE' } } as SessionTask), true);
  assert.equal(taskAccepted({ status: 'PASSED', project: { state: 'OPEN' } } as SessionTask), false);
});
