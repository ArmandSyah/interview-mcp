import { z } from 'zod';

export const executionPlanSchema = z.object({
  attempt_id: z.string().uuid(),
  problem_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  problem_revision: z.string().regex(/^[a-f0-9]{64}$/),
  function_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  python_version: z.literal('3.12.0'),
  test_cases: z
    .array(z.object({ input: z.array(z.unknown()), expected: z.unknown() }))
    .min(1)
    .max(100),
  execution_source: z.literal('local_report'),
  verification: z.literal('not_server_verified'),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type LocalCaseReport = {
  index: number;
  actual: unknown;
  user_stdout: string;
  user_stderr: string;
  error: string | null;
  wall_time_ms: number;
};
const DELIMITER = '__INTERVIEW_MCP_RESULT__';
const MAX_RESPONSE_BYTES = 1_000_000;
const shorten = (value: string, maximum: number) =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 20)}\n[output shortened]`;

function safeNumbers(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error('Local execution does not support this JSON number');
  if (Array.isArray(value)) for (const item of value) safeNumbers(item);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) safeNumbers(item);
}

async function boundedBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Piston returned an empty response');
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Piston response exceeds the size limit');
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export async function executeLocalPlan(
  plan: ExecutionPlan,
  code: string,
  pistonUrl: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<LocalCaseReport[]> {
  const url = new URL(pistonUrl);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Code execution needs an HTTP loopback Piston URL');
  if (!code.trim() || Buffer.byteLength(code, 'utf8') > 100_000)
    throw new Error('Supply code with a size from 1 byte to 100 KB');
  executionPlanSchema.parse(plan);
  safeNumbers(plan.test_cases);
  const reports: LocalCaseReport[] = [];
  for (const [index, fixture] of plan.test_cases.entries()) {
    signal?.throwIfAborted();
    const report: LocalCaseReport = {
      index,
      actual: null,
      user_stdout: '',
      user_stderr: '',
      error: null,
      wall_time_ms: 0,
    };
    const wrapper = `${code}\n\nimport json as _interview_mcp_json\n_interview_mcp_inputs = _interview_mcp_json.loads(${JSON.stringify(JSON.stringify(fixture.input))})\n_interview_mcp_result = ${plan.function_name}(*_interview_mcp_inputs)\nprint(${JSON.stringify(DELIMITER)})\nprint(_interview_mcp_json.dumps(_interview_mcp_result))\n`;
    try {
      const response = await request(`${url.href.replace(/\/$/, '')}/api/v2/execute`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'python',
          version: plan.python_version,
          stdin: '',
          run_timeout: 3000,
          run_memory_limit: 268435456,
          files: [{ content: wrapper }],
        }),
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok)
        throw new Error(`Piston rejected the execution request (HTTP ${response.status})`);
      const body = z
        .object({
          run: z.object({
            stdout: z.string().default(''),
            stderr: z.string().default(''),
            code: z.number().int().nullable(),
            signal: z.string().nullable().optional(),
            wall_time: z.number().nonnegative().optional(),
          }),
        })
        .parse(await boundedBody(response));
      const run = body.run;
      report.wall_time_ms = Math.min(9_999_999, Math.floor(run.wall_time ?? 0));
      report.user_stderr = shorten(run.stderr, 4000);
      const position = run.stdout.indexOf(DELIMITER);
      report.user_stdout = shorten(position < 0 ? run.stdout : run.stdout.slice(0, position), 4000);
      if (run.signal === 'SIGKILL')
        report.error = `Code execution exceeded its time or memory limit`;
      else if (run.code !== 0) report.error = `Piston exited with code ${run.code ?? -1}`;
      else if (position < 0) report.error = 'The function did not return a JSON result';
      else {
        const line = run.stdout
          .slice(position + DELIMITER.length)
          .trim()
          .split(/\r?\n/)[0];
        report.actual = JSON.parse(line);
        safeNumbers(report.actual);
        if (Buffer.byteLength(JSON.stringify(report.actual), 'utf8') > 15000)
          throw new Error('The function result exceeds the size limit');
      }
    } catch (error) {
      signal?.throwIfAborted();
      report.actual = null;
      // Network and schema errors can contain source text. Return fixed messages only.
      report.error =
        error instanceof Error &&
        /^(Piston rejected|The function result|Local execution does not support)/.test(
          error.message,
        )
          ? error.message
          : 'Local code execution failed. Examine the Piston service and code.';
    }
    reports.push(report);
  }
  return reports;
}
