import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: 'tests/installers',
  outputDir: 'test-results-installer',
  timeout: 240_000,
  preserveOutput: 'always',
  use: { trace: 'on' },
});
