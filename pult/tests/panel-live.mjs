import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const [kit, evidence] = process.argv.slice(2);
if (!kit || !evidence) throw Error('Нужны временная тестовая папка набора и каталог результатов');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
let page = await browser.newPage();
page.setDefaultTimeout(45000);
const host = 'http://127.0.0.1:18490';
const probe = (name, params) => {
  const program = "const [k,p]=process.argv.slice(1);require('/app/dist/probes/registry').EXECUTORS[k](JSON.parse(p),{dataDir:'/data',workDir:'/kit/work',label:'panel105'}).then(v=>process.stdout.write(JSON.stringify(v)),e=>{process.stderr.write(e.message);process.exitCode=1})";
  return JSON.parse(execFileSync('docker', ['exec', 'stands-kit-panel', 'node', '-e', program, name, JSON.stringify(params)], { encoding: 'utf8' }));
};
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const action = async (button, name, checked = false) => {
  const before = await page.evaluate(() => sessionStorage.getItem('stand-panel.operation'));
  for (let attempt = 0; ; attempt += 1) {
    const [response] = await Promise.all([
      page.waitForResponse((item) => item.url() === host + '/api/plans' && item.request().method() === 'POST'),
      button.click(),
    ]);
    const plan = await response.json();
    if (response.ok() && plan.allowed) break;
    if (plan.error?.code === 'OPERATION_CONFLICT' && attempt < 2) {
      await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/state')).json()).queue?.length)).toBe(0);
      continue;
    }
    assert.fail(`${name}: ${response.status()} ${plan.error?.message ?? plan.reason ?? 'план недоступен'}`);
  }
  const modal = page.getByRole('dialog');
  if (checked) await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name, exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('stand-panel.operation')), { timeout: 60000 }).not.toBe(before);
  const id = await page.evaluate(() => sessionStorage.getItem('stand-panel.operation'));
  let last;
  await expect.poll(async () => {
    try {
      last = await page.evaluate(async (id) => (await fetch('/api/operations/' + id)).json(), id);
      return ['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(last.state) ||
        last.state === 'WAITING_CONFIRMATION' && last.action?.action !== 'update.prepare';
    } catch { return false; }
  }, { timeout: 300000, intervals: [1000, 2000] }).toBe(true).catch((cause) => {
    throw new Error('Операция не завершилась: ' + JSON.stringify(last), { cause });
  });
  assert.equal(last.state, 'SUCCEEDED', JSON.stringify(last, null, 2));
  return id;
};
const stand = (title) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const bootstrapUrl = () => host + '/#bootstrap=' + execFileSync('docker', ['exec', 'stands-kit-panel', 'node', '/app/dist/main.js', 'panel', 'bootstrap'], { encoding: 'utf8' }).trim();
const stop = (...names) => execFileSync('docker', ['stop', ...names], { stdio: 'ignore' });
try {
  await page.goto(bootstrapUrl());
  await expect(page.getByRole('heading', { name: 'Задание', exact: true })).toBeVisible();
  await nav('Подключение');
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Платформа подключена');
  await page.keyboard.press('Escape');
  await nav('Стенды');
  await action(stand('Банк').getByRole('button', { name: 'Запустить', exact: true }), 'Запустить');
  const linux = stand('linux');
  await action(linux.getByRole('button', { name: 'Запустить', exact: true }), 'Запустить');
  const linuxContainer = () => execFileSync('docker', ['inspect', '--format', '{{.Id}}', 'stands-kit-linux-server'], { encoding: 'utf8' }).trim();
  const linuxId = linuxContainer();
  execFileSync('docker', ['exec', 'stands-kit-linux-server', 'sh', '-c', 'printf preserved > /home/student/panel-proof']);
  await action(linux.getByRole('button', { name: 'Перезапустить', exact: true }), 'Перезапустить');
  assert.equal(linuxContainer(), linuxId);
  await nav('Задание');
  await action(page.getByRole('button', { name: 'Подготовить задание', exact: true }), 'Подготовить задание');
  const id = probe('bank.transfer', { phone: '+79001110001', toPhone: '+79001110002', amountKop: 100, idempotencyKey: 'panel-live' }).operationId;
  assert.ok(id);
  probe('clickhouse.sql', { sql: 'CREATE TABLE default.panel_resume (id UInt64) ENGINE = MergeTree ORDER BY id; INSERT INTO default.panel_resume VALUES (7)' });
  probe('rabbitmq.importDefinitions', { definitions: { queues: [{ name: 'panel.live', vhost: '/', durable: true, auto_delete: false, arguments: {} }] } });
  assert.equal(probe('rabbitmq.publish', { exchange: '', routingKey: 'panel.live', payload: 'panel-live' }).routed, true);
  const mailbox = () => probe('rabbitmq.queue', { name: 'panel.live' }).messages;
  await expect.poll(mailbox).toBe(1);
  await nav('Мои файлы');
  await page.getByRole('button', { name: 'transfer.yaml', exact: true }).click();
  await page.getByRole('textbox').fill('amount: 101');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const verify = async () => {
    assert.equal(readFileSync(join(kit, 'work/transfer.yaml'), 'utf8'), 'amount: 101');
    assert.equal(probe('bank.operation', { id }).exists, true);
    assert.deepEqual(probe('clickhouse.query', { sql: 'SELECT id FROM default.panel_resume' }).rows, [{ id: 7 }]);
    await expect.poll(mailbox, { timeout: 30000 }).toBe(1);
  };
  await nav('Стенды');
  for (const title of ['Банк', 'rabbitmq']) {
    await action(stand(title).getByRole('button', { name: 'Перезапустить', exact: true }), 'Перезапустить');
    await verify();
  }
  stop('stands-kit-bank-core', 'stands-kit-bank-antifraud', 'stands-kit-bank-sbp', 'stands-kit-akhq', 'stands-kit-redpanda', 'stands-kit-clickhouse');
  await page.close();
  page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(bootstrapUrl());
  await expect.poll(async () => {
    try {
      const operation = await page.evaluate(async () => (await (await fetch('/api/operations')).json()).operations.find((item) => item.action.action === 'task.resume'));
      return operation?.state;
    } catch { return undefined; }
  }, { timeout: 300000 }).toBe('SUCCEEDED');
  await verify();
  stop('stands-kit-bank-core', 'stands-kit-clickhouse');
  await nav('Задание');
  await action(page.getByRole('button', { name: 'Проверить решение', exact: true }), 'Проверить решение');
  await verify();
  const oldScript = await page.locator('script[type=module]').getAttribute('src');
  await nav('Подключение');
  await action(page.getByRole('button', { name: 'Обновить пульт', exact: true }), 'Обновить пульт');
  await expect.poll(() => page.locator('script[type=module]').getAttribute('src')).not.toBe(oldScript);
  await verify();
  assert.equal(linuxContainer(), linuxId);
  assert.equal(execFileSync('docker', ['exec', 'stands-kit-linux-server', 'cat', '/home/student/panel-proof'], { encoding: 'utf8' }), 'preserved');
  await nav('Стенды');
  await stand('linux').getByRole('button', { name: 'Перезапустить', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /перенос|миграци|образ/i }).first()).toBeVisible();
  assert.equal(linuxContainer(), linuxId);
  await nav('Задание');
  await page.getByText('Подготовка сценария', { exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить заново', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Подготовить заново' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await verify();
  await action(page.getByRole('button', { name: 'Подготовить заново', exact: true }), 'Подготовить заново', true);
  assert.equal(probe('bank.operation', { id }).exists, false);
  assert.equal(readFileSync(join(kit, 'work/transfer.yaml'), 'utf8'), 'amount: 101');
  const facts = await page.evaluate(async () => ({ build: document.documentElement.dataset.build, asset: document.querySelector('script[type=module]').src,
    operations: (await (await fetch('/api/operations')).json()).operations.map(({ id, state, stage, action }) => ({ id, state, stage, action })) }));
  writeFileSync(join(evidence, 'operations.json'), JSON.stringify({ oldScript, ...facts }, null, 2));
  await page.screenshot({ path: join(evidence, 'updated-panel.png') });
} finally { await browser.close(); }

