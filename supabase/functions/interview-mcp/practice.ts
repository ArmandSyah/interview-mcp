import { type McpServer } from '@modelcontextprotocol/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export type PracticeCall = (
  operation: string,
  arguments_: Record<string, unknown>,
) => Promise<unknown>;
export type PracticeFactory = (request: Request, token: string) => PracticeCall;

const uuid = z.string().uuid();
const problemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const limit = z.number().int().min(1).max(500);
const session = z.object({ session_id: uuid }).strict();
const checkpoint = session.extend({ checkpoint_id: uuid }).strict();
const text = (maximum: number) =>
  z.string().refine((value) => Array.from(value).length <= maximum, 'Text is too long');
const element = z.object({
  id: text(128).refine((value) => value.length > 0),
  type: text(30).refine((value) => value.length > 0),
  label: text(2000).default(''),
  label_truncated: z.boolean().default(false),
  kind: text(60).default(''),
  from_id: text(128).nullable().default(null),
  to_id: text(128).nullable().default(null),
}).strict();
const notes = z.object({
  requirements: text(5000).optional(),
  api: text(5000).optional(),
  data: text(5000).optional(),
  capacity: text(5000).optional(),
  tradeoffs: text(5000).optional(),
  failure_modes: text(5000).optional(),
}).strict();

// No code execution, submission, paid pack, or queue tool is advertised here.
export const practiceSchemas = {
  get_problem_catalog: z.object({}).strict(),
  list_problems: z.object({
    difficulty: z.string().nullable().optional(),
    tag: z.string().nullable().optional(),
  }).strict(),
  start_problem: z.object({
    problem_id: problemId,
    language: z.literal('python').default('python'),
  }).strict(),
  get_problem_description: z.object({ attempt_id: uuid }).strict(),
  get_hint: z.object({
    current_code: z.string().refine((value) => new TextEncoder().encode(value).length <= 100_000),
    depth: z.number().int().default(1),
    attempt_id: uuid.nullable().optional(),
  }).strict(),
  get_progress: z.object({ limit: limit.default(50) }).strict(),
  list_design_problems: z.object({}).strict(),
  start_design_session: z.object({ problem_id: problemId }).strict(),
  get_design_brief: session,
  get_design_hint: session.extend({ depth: z.number().int().min(1).max(3).default(1) }).strict(),
  save_design_checkpoint: checkpoint.extend({
    scene_digest: z.string().regex(/^[a-f0-9]{64}$/),
    notes,
    diagram: z.array(element).max(3000).refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 700_000,
      'Diagram summary is too large',
    ),
    label: text(80).refine((value) => value.trim().length > 0).default('Checkpoint'),
  }).strict(),
  list_design_checkpoints: session.extend({ limit: limit.default(100) }).strict(),
  get_design_snapshot: checkpoint,
  evaluate_design: checkpoint,
  finish_design_session: checkpoint,
};

const descriptions: Record<keyof typeof practiceSchemas, string> = {
  get_problem_catalog: 'Return available problem filters.',
  list_problems: 'Return available coding problems without solutions.',
  start_problem: 'Start an owned attempt and return a Python scaffold.',
  get_problem_description: 'Return the description from this attempt content revision.',
  get_hint: 'Return one curated hint from this attempt content revision.',
  get_progress: 'Return recent owned coding attempts.',
  list_design_problems: 'Return available system-design briefs.',
  start_design_session: 'Start an owned design session and keep its content revision.',
  get_design_brief: 'Return the brief from this session content revision.',
  get_design_hint: 'Return one curated hint from this session content revision.',
  save_design_checkpoint: 'Save immutable notes and diagram evidence for this session.',
  list_design_checkpoints: 'Return owned checkpoints, newest first.',
  get_design_snapshot: 'Return the saved evidence of an owned checkpoint.',
  evaluate_design: 'Record a discussion coverage review, not a correctness grade.',
  finish_design_session: 'Complete this session after a checkpoint review.',
};
const readOnly = new Set([
  'get_problem_catalog',
  'list_problems',
  'get_problem_description',
  'get_hint',
  'get_progress',
  'list_design_problems',
  'get_design_brief',
  'get_design_hint',
  'list_design_checkpoints',
  'get_design_snapshot',
]);

export function registerPracticeTools(server: McpServer, call: PracticeCall): void {
  for (const [name, schema] of Object.entries(practiceSchemas)) {
    server.registerTool(name, {
      description: descriptions[name as keyof typeof practiceSchemas],
      inputSchema: schema,
      annotations: { readOnlyHint: readOnly.has(name), destructiveHint: false },
    }, async (arguments_: Record<string, unknown>) => {
      try {
        const result = await call(name, arguments_);
        return {
          content: [{
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result),
          }],
          structuredContent: { result },
        };
      } catch (error) {
        // Only known contract errors may reach the client. Never return SQL/provider data.
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: error instanceof PracticeError ? error.message : 'Practice service unavailable.',
          }],
        };
      }
    });
  }
}

export class PracticeError extends Error {}

export function createPracticeFactory(
  url: string,
  key: string,
  requestFetch: typeof fetch = fetch,
): PracticeFactory {
  return (request, token) => {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) =>
          requestFetch(input, {
            ...init,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
          }),
      },
    });
    return async (operation, arguments_) => {
      const { data, error } = await client.rpc('iwb_practice', {
        operation,
        arguments: arguments_,
      });
      if (error) {
        const safeMessages = new Set([
          'Problem is not available.',
          'Python is the only supported language.',
          'limit must be between 1 and 500.',
          'Attempt not found. Call start_problem first.',
          'Solution code must be at most 100 KB.',
          'Design session not found.',
          'Hint depth must be between 1 and 3.',
          'Checkpoint limit must be between 1 and 500.',
          'Start a new practice session to add evidence after finishing.',
          'Invalid scene fingerprint.',
          'Checkpoint label must contain 1-80 characters.',
          'Use the six design-note sections, at most 5000 characters each.',
          'Diagram summary is too large or invalid.',
          'Diagram summary is too large.',
          'Invalid diagram element.',
          'A checkpoint is immutable; create a new revision.',
          'Design checkpoint not found.',
          'Review this checkpoint before finishing the session.',
        ]);
        if (safeMessages.has(error.message)) throw new PracticeError(error.message);
        throw new Error('Practice service unavailable.');
      }
      return data;
    };
  };
}
