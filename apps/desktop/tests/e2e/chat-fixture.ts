import { createServer, type ServerResponse } from 'node:http';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** A local provider fixture. It never loads a model or sends a paid request. */
export async function controlledCoach(approval = false) {
  const requests: { response: ServerResponse; closed: boolean }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the request body. */
    }
    const entry = { response, closed: false };
    requests.push(entry);
    response.on('close', () => {
      entry.closed = true;
    });
    response.setHeader('Content-Type', 'application/x-ndjson');
    if (approval && requests.length === 1) {
      response.end(
        JSON.stringify({
          message: {
            content: '',
            tool_calls: [{ function: { name: 'submit_solution', arguments: {} } }],
          },
          done: true,
        }) + '\n',
      );
    } else {
      response.write(
        JSON.stringify({
          message: { content: `Fixture partial response ${requests.length}.` },
          done: false,
        }) + '\n',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    finish(index: number, text: string) {
      requests[index].response.end(
        JSON.stringify({ message: { content: text }, done: true }) + '\n',
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function openCoach(page: Page, url: string, mode: 'coding' | 'design' = 'coding') {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByLabel('Provider').selectOption('ollama');
  await page.getByLabel('Ollama URL').fill(url);
  await page.getByRole('button', { name: 'Save & connect' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (mode === 'coding') {
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'coach', exact: true }).click();
  }
  return {
    composer: page.getByRole('textbox', {
      name: mode === 'coding' ? 'Message the coach' : 'Message the design coach',
      exact: true,
    }),
    send: page.getByRole('button', {
      name: mode === 'coding' ? 'Send message' : 'Send design message',
      exact: true,
    }),
  };
}
