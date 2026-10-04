import { describe, expect, it } from 'vitest';
import { AnthropicModel, OllamaModel } from '../src/main/providers';
import type { Tool } from '@modelcontextprotocol/client';

const tools: Tool[] = [{ name: 'get_progress', inputSchema: { type: 'object', properties: {} } }];
describe('real provider wire formats (no paid requests)', () => {
  it('streams Ollama text and captures its tool calls', async () => {
    let request: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      request = JSON.parse(init?.body as string);
      return new Response(
        [
          JSON.stringify({ message: { content: 'Let’s ' } }),
          JSON.stringify({
            message: {
              content: 'check.',
              tool_calls: [{ function: { name: 'get_progress', arguments: {} } }],
            },
          }),
          JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 5 }),
        ].join('\n'),
      );
    };
    const deltas: string[] = [];
    const value = await new OllamaModel('http://127.0.0.1:11434', 'test-model', fetcher).complete(
      'Coach',
      [{ role: 'user', text: 'How am I doing?' }],
      tools,
      new AbortController().signal,
      (text) => deltas.push(text),
    );
    expect(deltas.join('')).toBe('Let’s check.');
    expect(value.calls[0].name).toBe('get_progress');
    expect(request.tools).toHaveLength(1);
    expect(value.inputTokens).toBe(20);
  });
  it('rejects non-loopback Ollama URLs', async () => {
    await expect(
      new OllamaModel('http://remote.invalid', 'model').complete(
        '',
        [],
        [],
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('loopback');
  });
  it('streams Claude events and maintains tool_use / tool_result pairing', async () => {
    let request: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      request = JSON.parse(init?.body as string);
      return new Response(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call-id', name: 'get_progress' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'One step at a time.' },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    };
    const value = await new AnthropicModel('not-a-real-secret', 'model', fetcher).complete(
      'Coach',
      [
        { role: 'user', text: 'Check progress' },
        {
          role: 'assistant',
          text: '',
          calls: [{ id: 'previous', name: 'get_progress', args: {} }],
        },
        { role: 'tool', text: 'No attempts', callId: 'previous', tool: 'get_progress' },
      ],
      tools,
      new AbortController().signal,
      () => {},
    );
    expect(value.calls).toEqual([{ id: 'call-id', name: 'get_progress', args: {} }]);
    expect(value.text).toBe('One step at a time.');
    expect(JSON.stringify(request.messages)).toContain('tool_result');
    expect(JSON.stringify(request.messages)).toContain('previous');
  });
  it('does not expose upstream response bodies on credential errors', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('secret-key echoed by upstream', { status: 401 });
    await expect(
      new AnthropicModel('secret-key', 'model', fetcher).complete(
        '',
        [],
        [],
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('HTTP 401');
  });
});
