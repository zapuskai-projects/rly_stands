import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const prefix = '/api/stand-kit';
let fingerprint;
let attempt = false;
let result = null;
const expiresAt = new Date(Date.now() + 12 * 3600000).toISOString();
const modules = ['rabbitmq', 'kafka', 'postgres', 'bank', 'linux'].map((profile) => ({ key: profile, profile, title: profile === 'bank' ? 'Банк' : profile,
  requires: profile === 'bank' ? ['rabbitmq', 'kafka', 'postgres'] : [], minMemoryMb: 32, uis: [], allowed: true, reason: null }));
const probes = [{ id: 'student-file', probe: 'file.exists', params: { path: 'transfer.yaml' } }];
createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : {};
  const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const path = req.url.slice(prefix.length);
  if (path === '/device' && req.method === 'POST') {
    fingerprint = input.tokenHash;
    return reply({ id: 'device', code: 'PANEL-TEST', verifyUrl: null, expiresAt, intervalSec: 1 });
  }
  if (path === '/device/device') return reply({ status: 'APPROVED' });
  const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!fingerprint || createHash('sha256').update(bearer).digest('hex') !== fingerprint) return reply({ message: 'Войдите по коду устройства' }, 401);
  const task = { id: 'transfer', title: 'Проверка перевода', modules: [{ key: 'bank', title: 'Банк' }], status: result?.passed ? 'PASSED' : attempt ? 'STARTED' : 'NOT_STARTED', attemptId: attempt ? 'attempt' : null, label: attempt ? 'panel105' : null,
    needsUpdate: false, missingPrimitives: [], verifiedOnStand: null, verifiedFailureOnStand: null };
  if (path === '/session') return reply({ user: { name: 'Тестовый ученик' }, token: { expiresAt }, kit: { latestVersion: '0.0.902', minVersion: '0.0.901', offlineGraceHours: 24 }, projects: [], tasks: [task], modules });
  if (path === '/tasks/transfer/state') return reply({ labId: 'transfer', label: task.label, status: task.status, attemptId: task.attemptId, result, modules: task.modules });
  if (path === '/tasks/transfer/start') {
    attempt = true;
    return reply({ attemptId: 'attempt', label: 'panel105', title: task.title, promptMd: 'Сохраните transfer.yaml', hint: null, modules: task.modules,
      seed: [{ action: 'bank.scenario', params: { reset: true, bankTime: 'noon', defects: [] } }], probes });
  }
  if (path === '/attempts/attempt/probes') return reply({ attemptId: 'attempt', label: 'panel105', probes });
  if (path === '/attempts/attempt/check') {
    const passed = input.observations?.['student-file']?.exists === true;
    result = { passed, unavailable: false, message: passed ? 'Файл найден' : 'Файл отсутствует', detail: null,
      assertionResults: [{ id: 'student-file', title: 'Файл перевода сохранён', passed, unavailable: false }], summary: { passed: Number(passed), total: 1 } };
    return reply({ attemptId: 'attempt', status: passed ? 'PASSED' : 'FAILED', result });
  }
  return reply({ message: path }, 404);
}).listen(18599, '0.0.0.0');

