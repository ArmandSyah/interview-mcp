import { expect, it } from 'vitest';
import { desktopEnvironment } from './desktop-environment';

it('keeps platform values and isolates the test workspace without unrelated environment values', () => {
  const source = {
    PATH: '/fixture/bin',
    DISPLAY: ':99',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\fixture-temp',
    ANTHROPIC_API_KEY: 'fixture-not-a-secret',
    GH_TOKEN: 'fixture-not-a-secret',
    NODE_OPTIONS: '--require unrelated-module',
    INTERVIEW_DESKTOP_PYTHON: '/fixture/python',
    INTERVIEW_DESKTOP_DATA_DIR: '/not-the-test-workspace',
    INTERVIEW_DESKTOP_PROBLEMS_DIR: '/not-the-test-corpus',
  };
  expect(desktopEnvironment('/fixture/data', 'http://127.0.0.1:1234', source)).toEqual({
    PATH: source.PATH,
    DISPLAY: source.DISPLAY,
    SystemRoot: source.SystemRoot,
    TEMP: source.TEMP,
    INTERVIEW_DESKTOP_PYTHON: source.INTERVIEW_DESKTOP_PYTHON,
    INTERVIEW_DESKTOP_DATA_DIR: '/fixture/data',
    INTERVIEW_DESKTOP_PROBLEMS_DIR: '',
    INTERVIEW_DESKTOP_DEV_URL: 'http://127.0.0.1:1234',
  });
  expect(source.INTERVIEW_DESKTOP_DATA_DIR).toBe('/not-the-test-workspace');
});
