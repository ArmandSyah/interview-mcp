import { z } from 'zod';
import type { Submission, TestRun } from './types';

const count = z.number().int().nonnegative();
const testRunSchema = z
  .object({
    attempt_id: z.string(),
    problem_id: z.string(),
    tests_total: count,
    tests_passed: count,
    tests: z.array(
      z
        .object({
          index: count,
          passed: z.boolean(),
          input: z.array(z.unknown()),
          expected: z.unknown(),
          actual: z.unknown().default(null),
          user_stdout: z.string().default(''),
          user_stderr: z.string().default(''),
          error: z.string().nullable().default(null),
          wall_time_ms: count.default(0),
        })
        .passthrough(),
    ),
    all_passed: z.boolean(),
    execution_source: z.literal('local_report').optional(),
    verification: z.literal('not_server_verified').optional(),
  })
  .passthrough()
  .refine(
    (run) =>
      run.tests_total === run.tests.length &&
      run.tests_passed === run.tests.filter((test) => test.passed).length &&
      run.all_passed === (run.tests_total > 0 && run.tests_passed === run.tests_total) &&
      new Set(run.tests.map((test) => test.index)).size === run.tests.length,
  );
const submissionSchema = z
  .object({
    completed: z.boolean(),
    test_run: testRunSchema,
    followup_questions: z.string().nullable().default(null),
    message: z.string(),
  })
  .passthrough();

/** Return a report for this attempt and problem. Invalid input throws without state changes. */
export function parseTestReport(value: unknown, attemptId: string, problemId: string): TestRun {
  const parsed = testRunSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.attempt_id !== attemptId ||
    parsed.data.problem_id !== problemId
  )
    throw new Error('Invalid test report. The previous result has not changed.');
  return parsed.data;
}

/** Validate the submission and its report before the caller changes the session. */
export function parseSubmission(value: unknown, attemptId: string, problemId: string): Submission {
  const parsed = submissionSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Invalid submission report. The previous result has not changed.');
  parseTestReport(parsed.data.test_run, attemptId, problemId);
  return parsed.data;
}
