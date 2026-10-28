import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: 'tests/diagnostics',
  outputDir: 'test-results-diagnostics',
  preserveOutput: 'always',
  use: { trace: 'on' },
});
