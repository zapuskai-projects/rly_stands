import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, timeout: 45000,
  outputDir: process.env.PANEL_TEST_OUTPUT ?? join(tmpdir(), 'stand-panel-browser-results'),
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:18490', trace: 'retain-on-failure' },
});
