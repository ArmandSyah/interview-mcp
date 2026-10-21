import { expect, it } from 'vitest';
import { parseSubmission, parseTestReport } from '../src/shared/test-report';
import { testReport } from './test-report-fixture';

const report = () => testReport('attempt', 'problem');
it('accepts the public report fields, defaults, metadata, and non-UUID attempt IDs', () => {
  const value = report();
  const { actual, user_stdout, user_stderr, error, wall_time_ms, ...required } = value.tests[0];
  expect(
    parseTestReport({ ...value, tests: [required], extension: 'retained' }, 'attempt', 'problem'),
  ).toEqual({ ...value, tests: [{ ...value.tests[0], wall_time_ms: 0 }], extension: 'retained' });
  expect(
    parseTestReport(
      { ...value, execution_source: 'local_report', verification: 'not_server_verified' },
      'attempt',
      'problem',
    ),
  ).toMatchObject({ execution_source: 'local_report', verification: 'not_server_verified' });
  expect(
    parseSubmission(
      { completed: false, test_run: value, message: 'Review the result' },
      'attempt',
      'problem',
    ).followup_questions,
  ).toBeNull();
  expect(
    parseTestReport({ ...value, tests: [], tests_total: 0 }, 'attempt', 'problem').tests,
  ).toEqual([]);
});

it.each([
  ['null', null],
  ['missing cases', { ...report(), tests: undefined }],
  ['object cases', { ...report(), tests: {} }],
  ['null case', { ...report(), tests: [null] }],
  ['different attempt', { ...report(), attempt_id: 'other' }],
  ['different problem', { ...report(), problem_id: 'other' }],
  ['missing attempt', { ...report(), attempt_id: undefined }],
  ['wrong total', { ...report(), tests_total: 2 }],
  ['wrong pass count', { ...report(), tests_passed: 1 }],
  ['wrong summary', { ...report(), all_passed: true }],
  ['negative total', { ...report(), tests_total: -1 }],
  ['noninteger total', { ...report(), tests_total: 0.5 }],
  ['nonboolean summary', { ...report(), all_passed: 'false' }],
  [
    'duplicate cases',
    { ...report(), tests: [report().tests[0], report().tests[0]], tests_total: 2 },
  ],
  ['object stdout', { ...report(), tests: [{ ...report().tests[0], user_stdout: {} }] }],
  ['object error', { ...report(), tests: [{ ...report().tests[0], error: {} }] }],
  ['nonboolean pass', { ...report(), tests: [{ ...report().tests[0], passed: 'false' }] }],
  ['invalid input', { ...report(), tests: [{ ...report().tests[0], input: null }] }],
  ['negative case index', { ...report(), tests: [{ ...report().tests[0], index: -1 }] }],
  ['negative time', { ...report(), tests: [{ ...report().tests[0], wall_time_ms: -1 }] }],
  ['infinite time', { ...report(), tests: [{ ...report().tests[0], wall_time_ms: Infinity }] }],
])('rejects %s without changing the supplied report', (_label, value) => {
  const previous = structuredClone(value);
  expect(() => parseTestReport(value, 'attempt', 'problem')).toThrow('Invalid test report');
  expect(value).toEqual(previous);
});

it.each([
  ['missing result', { completed: true, message: 'done' }],
  ['invalid completion', { completed: 'true', test_run: report(), message: 'done' }],
  [
    'invalid follow-up',
    { completed: true, test_run: report(), message: 'done', followup_questions: {} },
  ],
  ['missing message', { completed: true, test_run: report() }],
  [
    'wrong attempt',
    { completed: true, test_run: { ...report(), attempt_id: 'other' }, message: 'done' },
  ],
])('rejects a submission with %s', (_label, value) => {
  expect(() => parseSubmission(value, 'attempt', 'problem')).toThrow(/Invalid .* report/);
});
