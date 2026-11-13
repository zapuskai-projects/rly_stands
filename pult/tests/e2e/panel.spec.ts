import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadRuntime } from '../../src/config';
import { Controller } from '../../src/panel/controller';
import { mintBootstrap } from '../../src/panel/auth';
import { Router } from '../../src/panel/router';

let controller: Controller;
let server: Server;
let dir: string;
const root = resolve(__dirname, '../..');
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stand panel tests '));
  mkdirSync(join(dir, 'work'));
  writeFileSync(join(dir, 'VERSION'), '1.0.0');
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_HOST_DIR: dir, KIT_VERSION: '1.0.0' });
  const assets = join(root, 'dist/panel-web');
  const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));
  controller = new Controller(runtime, manifest.uiBuildId);
  const router = new Router(controller, { ...manifest, instanceId: 'browser-test', version: runtime.version }, assets);
  server = createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(18490, '127.0.0.1', ok); });
});
test.afterAll(async () => {
  if (server?.listening) await new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const width of [360, 768, 1440]) {
  test('пять разделов и вход, ширина ' + width, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Вход в локальный пульт' })).toBeVisible();
    await page.goto('about:blank');
    await page.goto('/#bootstrap=' + mintBootstrap(controller.store));
    await expect(page.getByRole('heading', { name: 'Задание', exact: true })).toBeVisible();
    for (const name of ['Задание', 'Стенды', 'Мои файлы', 'История', 'Подключение']) {
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(name + '-' + width + '.png') });
    }
    expect(new URL(page.url()).hash).toBe('');
  });
}

test('редактор сохраняет введённый текст и обнаруживает внешнее изменение', async ({ page }, info) => {
  const path = join(dir, 'work', 'transfer.yaml');
  writeFileSync(path, 'amount: 100');
  await page.goto('/#bootstrap=' + mintBootstrap(controller.store));
  await expect(page.getByRole('heading', { name: 'Задание', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Мои файлы', exact: true }).click();
  await page.getByRole('button', { name: 'transfer.yaml', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Содержимое transfer.yaml' });
  await editor.fill('amount: 150');
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveValue('amount: 150');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('amount: 150');
  await editor.fill('amount: 200');
  writeFileSync(path, 'amount: 175');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Файл изменился на диске');
  await page.screenshot({ path: info.outputPath('conflict.png') });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveValue('amount: 200');
  expect(readFileSync(path, 'utf8')).toBe('amount: 175');
});
