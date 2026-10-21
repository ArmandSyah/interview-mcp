import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** Local protocol fixture. This server does not test Supabase token verification. */
export async function accountServer(
  execution?: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  let origin = '';
  let failure: 'identity' | 'catalog' | null = null;
  let release: (() => void) | undefined;
  let identityGate: Promise<void> | undefined;
  const requests: { name: string; account: string; args: Record<string, unknown> }[] = [];
  const names = [
    'get_connection_identity',
    'list_problems',
    'get_progress',
    'start_problem',
    'get_problem_description',
    'get_hint',
    ...(execution ? ['run_tests', 'submit_solution'] : []),
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
      const failed =
        (failure === 'identity' && name === 'get_connection_identity') ||
        (failure === 'catalog' && name === 'list_problems');
      let value: unknown;
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
      if (execution && ['run_tests', 'submit_solution'].includes(name))
        value = await execution(name, body.params.arguments ?? {});
      if (name === 'start_problem') {
        const contents = `# ${account} starter\n`;
        value = {
          attempt_id:
            account === 'alice'
              ? '33333333-3333-4333-8333-333333333333'
              : '44444444-4444-4444-8444-444444444444',
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
        ? { isError: true, content: [{ type: 'text', text: `Fixture ${failure} failure` }] }
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

export async function connectAccount(page: Page, url: string, token: string, provider?: 'ollama') {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
  if (provider) await dialog.getByLabel('Provider').selectOption(provider);
  await dialog.getByLabel('Connection').selectOption('remote');
  await dialog.getByLabel('HTTPS MCP URL').fill(url);
  await dialog.getByLabel('MCP bearer key or account token', { exact: true }).fill(token);
  await dialog.getByRole('button', { name: 'Save & connect' }).click();
  await expect(dialog).toHaveCount(0);
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
