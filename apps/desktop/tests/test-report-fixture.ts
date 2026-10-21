import type { TestRun } from '../src/shared/types';

export function testReport(attemptId: string, problemId: string, passed = false): TestRun {
  return {
    attempt_id: attemptId,
    problem_id: problemId,
    tests_total: 1,
    tests_passed: Number(passed),
    all_passed: passed,
    tests: [
      {
        index: 0,
        passed,
        input: [2],
        expected: 2,
        actual: passed ? 2 : null,
        user_stdout: '',
        user_stderr: '',
        error: null,
        wall_time_ms: 4,
      },
    ],
  };
}
