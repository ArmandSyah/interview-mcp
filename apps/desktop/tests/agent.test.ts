import { describe, expect, it, vi } from 'vitest';
import { COACH_PROMPT, runAgent } from '../src/main/agent';
import type { Model } from '../src/main/providers';
import type { ChatItem } from '../src/shared/types';
import type { Tool } from '@modelcontextprotocol/client';

const tools: Tool[] = [{ name: 'get_hint', inputSchema: { type: 'object' } }];
describe('bounded MCP agent harness', () => {
  it('routes model tool calls and sends actual results back to the model', async () => {
    let round = 0;
    const events: ChatItem[] = [];
    const model: Model = {
      complete: async (system, messages, _tools, _signal, delta) => {
        expect(system).toContain('Never provide a complete solution');
        if (++round === 1)
          return { text: '', calls: [{ id: 'call', name: 'get_hint', args: { depth: 1 } }] };
        expect(messages.at(-1)?.text).toContain('Consider an invariant');
        delta('What must stay true?');
        return { text: 'What must stay true?', calls: [] };
      },
    };
    const execute = vi.fn(async () => ({ hint: 'Consider an invariant' }));
    await runAgent({
      model,
      tools,
      message: 'Help',
      history: [],
      context: '# candidate draft',
      signal: new AbortController().signal,
      emit: (item) => events.push(item),
      execute,
    });
    expect(execute).toHaveBeenCalledWith('get_hint', { depth: 1 }, expect.any(AbortSignal));
    expect(events.some((item) => item.role === 'tool' && item.status === 'done')).toBe(true);
    expect(events.at(-1)?.text).toBe('What must stay true?');
  });
  it('allows only one hint per turn and rejects unknown tool calls', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({}));
    const model: Model = {
      complete: async (_system, messages, _tools, _signal, delta) => {
        if (++round === 1)
          return {
            text: '',
            calls: [
              { id: 'a', name: 'get_hint', args: {} },
              { id: 'b', name: 'get_hint', args: {} },
              { id: 'c', name: 'shell', args: { command: 'bad' } },
            ],
          };
        expect(
          messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.text)
            .join(' '),
        ).toContain('Only one hint');
        delta('Your turn.');
        return { text: 'Your turn.', calls: [] };
      },
    };
    await runAgent({
      model,
      tools,
      message: 'Help',
      history: [],
      context: '',
      signal: new AbortController().signal,
      emit: () => {},
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('stops an infinite tool loop and respects cancellation', async () => {
    const model: Model = {
      complete: async () => ({ text: '', calls: [{ id: 'x', name: 'get_hint', args: {} }] }),
    };
    await expect(
      runAgent({
        model,
        tools,
        message: 'Help',
        history: [],
        context: '',
        signal: new AbortController().signal,
        emit: () => {},
        execute: async () => ({}),
      }),
    ).rejects.toThrow('turn limit');
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgent({
        model,
        tools,
        message: 'Help',
        history: [],
        context: '',
        signal: controller.signal,
        emit: () => {},
        execute: async () => ({}),
      }),
    ).rejects.toThrow();
    expect(COACH_PROMPT).toContain('untrusted data');
  });
});
