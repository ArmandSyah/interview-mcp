import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/evidence',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  outputDir: 'test-results-evidence',
  preserveOutput: 'always',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-evidence-report', open: 'never' }],
    ['json', { outputFile: 'test-results-evidence/results.json' }],
  ],
});
