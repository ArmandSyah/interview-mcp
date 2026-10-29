import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { noteSections, type DesignBrief, type DesignSession } from '../../src/shared/design';
import { accountQueueFixture } from './account-queue-fixture';

/** Local protocol fixture. This server does not test Supabase token verification. */
export async function accountServer(
  execution?: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  options: { design?: boolean; queue?: boolean } = {},
) {
  let origin = '';
  let failure: 'identity' | 'catalog' | null = null;
  let release: (() => void) | undefined;
  let identityGate: Promise<void> | undefined;
  const requests: { name: string; account: string; args: Record<string, unknown> }[] = [];
  const designSessions = new Map<string, { account: string; record: Partial<DesignSession> }>();
  const queue = options.queue ? accountQueueFixture() : null;
  const brief: DesignBrief = {
    id: 'fixture-design',
    title: 'Account design fixture',
    difficulty: 'easy',
    tags: [],
    brief_md: 'This fixture tests account ownership of design drafts.',
    requirements: ['Keep each account draft in its workspace.'],
    constraints: [],
    scenarios: [],
    rubric: noteSections.map(({ key, title }) => ({ key, title, prompt: 'Record fixture notes.' })),
    time_budget_minutes: 40,
    revision: 'a'.repeat(64),
    pack_id: 'fixture',
  };
  const names = [
    'get_connection_identity',
    'list_problems',
    'get_progress',
    'start_problem',
    'get_problem_description',
    'get_hint',
    ...(execution ? ['run_tests', 'submit_solution'] : []),
    ...(options.design
      ? ['list_design_problems', 'start_design_session', 'get_design_session']
      : []),
    ...(queue?.names ?? []),
  ];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const account = request.headers.authorization?.includes('bob') ? 'bob' : 'alice';
    let result: unknown;
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'account-ui-fixture', version: '1.0.0' },
      };
    else if (body.method === 'tools/list')
      result = { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else {
      const name = body.params.name;
      requests.push({ name, account, args: body.params.arguments ?? {} });
      if (name === 'get_connection_identity') await identityGate;
      let failed =
        (failure === 'identity' && name === 'get_connection_identity') ||
        (failure === 'catalog' && name === 'list_problems');
      let queueError: string | undefined;
      let value: unknown;
      if (queue?.names.includes(name)) {
        try {
          value = queue.call(account, name, body.params.arguments ?? {});
        } catch (error) {
          failed = true;
          queueError = error instanceof Error ? error.message : 'Fixture queue failure';
        }
      }
      if (name === 'get_connection_identity')
        value = {
          user_id:
            account === 'alice'
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          issuer: `${origin}/auth/v1`,
          backend: 'supabase',
        };
      if (name === 'list_problems')
        value = [
          {
            id: 'fixture-account',
            title: 'Account fixture',
            difficulty: 'easy',
            tags: [],
            pattern_tags: [],
          },
        ];
      if (name === 'get_progress') value = `Fixture progress for ${account}`;
      if (name === 'get_problem_description') value = 'This fixture tests account draft ownership.';
      if (name === 'get_hint') value = { hint: `Fixture hint for ${account}` };
      if (options.design && name === 'list_design_problems') value = [brief];
      if (options.design && name === 'start_design_session') {
        const record: Partial<DesignSession> = {
          id: randomUUID(),
          problem_id: brief.id,
          brief,
          status: 'in_progress',
          started_at: '2026-01-01T00:00:00Z',
          completed_at: null,
        };
        designSessions.set(record.id!, { account, record });
        queue?.register(account, {
          id: record.id!,
          kind: 'design',
          problem_id: brief.id,
          problem_revision: brief.revision,
          title: brief.title,
          status: 'in_progress',
          started_at: record.started_at!,
          queued_id: null,
        });
        value = record;
      }
      if (options.design && name === 'get_design_session') {
        const stored = designSessions.get(body.params.arguments?.session_id);
        if (!stored || stored.account !== account) failed = true;
        else value = stored.record;
      }
      if (execution && ['run_tests', 'submit_solution'].includes(name))
        value = await execution(name, body.params.arguments ?? {});
      if (name === 'start_problem') {
        const contents = `# ${account} starter\n`;
        const attemptId =
          account === 'alice'
            ? '33333333-3333-4333-8333-333333333333'
            : '44444444-4444-4444-8444-444444444444';
        queue?.register(account, {
          id: attemptId,
          kind: 'coding',
          problem_id: 'fixture-account',
          problem_revision: 'a'.repeat(64),
          title: 'Account fixture',
          status: 'in_progress',
          started_at: '2026-01-01T00:00:00Z',
          queued_id: null,
        });
        value = {
          attempt_id: attemptId,
          mode: 'remote',
          files_to_create: [
            {
              relative_path: 'fixture-account/solution.py',
              contents,
              sha256: createHash('sha256').update(contents).digest('hex'),
            },
          ],
        };
      }
      result = failed
        ? {
            isError: true,
            content: [{ type: 'text', text: queueError ?? `Fixture ${failure} failure` }],
          }
        : {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: name === 'get_connection_identity' ? value : { result: value },
          };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    requests,
    fail: (value: typeof failure) => {
      failure = value;
    },
    holdIdentity: () => {
      identityGate = new Promise<void>((done) => {
        release = done;
      });
    },
    releaseIdentity: () => {
      release?.();
      identityGate = undefined;
    },
    close: () =>
      new Promise<void>((done, reject) => {
        release?.();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}

export async function connectAccount(
  page: Page,
  url: string,
  token: string,
  provider?: 'ollama',
  timeout = 5000,
) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
  if (provider) await dialog.getByLabel('Provider').selectOption(provider);
  await dialog.getByLabel('Connection').selectOption('remote');
  await dialog.getByLabel('HTTPS MCP URL').fill(url);
  await dialog.getByLabel('MCP bearer key or account token', { exact: true }).fill(token);
  await dialog.getByRole('button', { name: 'Save & connect' }).click();
  await expect(dialog).toHaveCount(0, { timeout });
  // An account change can replace the view before its connection completes.
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
}

export async function pasteAccountDraft(page: Page, code: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, code);
  await expect
    .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0].code)
    .toBe(code);
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
}
