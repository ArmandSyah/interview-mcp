import type { Tool } from '@modelcontextprotocol/client';

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Message = {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  calls?: ToolCall[];
  callId?: string;
  tool?: string;
};
export type Completion = {
  text: string;
  calls: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
};
export interface Model {
  complete(
    system: string,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal,
    delta: (text: string) => void,
  ): Promise<Completion>;
}

async function* lines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('Model returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) yield buffer.trim();
        return;
      }
      bytes += value.byteLength;
      if (bytes > 4_000_000) throw new Error('Model response exceeded the stream limit');
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield line;
      }
      if (buffer.length > 1_000_000) throw new Error('Model response exceeded the stream limit');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OllamaModel implements Model {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async complete(
    system: string,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal,
    delta: (text: string) => void,
  ): Promise<Completion> {
    const url = new URL(this.url);
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('Ollama must use an HTTP loopback address');
    const response = await this.fetcher(new URL('/api/chat', url), {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        think: false,
        options: { num_predict: 900 },
        messages: [
          { role: 'system', content: system },
          ...messages.map((message) => ({
            role: message.role,
            content: message.text,
            ...(message.calls?.length
              ? {
                  tool_calls: message.calls.map((call) => ({
                    function: { name: call.name, arguments: call.args },
                  })),
                }
              : {}),
            ...(message.tool ? { tool_name: message.tool } : {}),
          })),
        ],
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
    });
    if (!response.ok)
      throw new Error(
        `Ollama returned HTTP ${response.status}. Check that the model is installed and supports tools.`,
      );
    const result: Completion = { text: '', calls: [] };
    for await (const line of lines(response)) {
      const chunk = JSON.parse(line);
      if (chunk.error)
        throw new Error('Ollama could not complete this request. Check the installed model.');
      if (chunk.message?.content) {
        result.text += chunk.message.content;
        delta(chunk.message.content);
      }
      for (const call of chunk.message?.tool_calls ?? [])
        result.calls.push({
          id: `ollama-${result.calls.length}`,
          name: call.function.name,
          args: call.function.arguments ?? {},
        });
      if (chunk.done) {
        result.inputTokens = chunk.prompt_eval_count;
        result.outputTokens = chunk.eval_count;
      }
    }
    return result;
  }
}

export class AnthropicModel implements Model {
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async complete(
    system: string,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal,
    delta: (text: string) => void,
  ): Promise<Completion> {
    const converted: { role: string; content: unknown[] }[] = [];
    for (const message of messages) {
      const role = message.role === 'tool' ? 'user' : message.role;
      const content: unknown[] =
        message.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: message.callId, content: message.text }]
          : [
              ...(message.text ? [{ type: 'text', text: message.text }] : []),
              ...(message.calls ?? []).map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.args,
              })),
            ];
      const previous = converted.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else converted.push({ role, content });
    }
    const response = await this.fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 900,
        stream: true,
        system,
        messages: converted,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      }),
    });
    if (!response.ok)
      throw new Error(
        `Claude returned HTTP ${response.status}. Check your model, API key and account quota.`,
      );
    const result: Completion = { text: '', calls: [] };
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    for await (const line of lines(response)) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'error')
        throw new Error('Claude interrupted the response. Try again or check your quota.');
      if (event.type === 'message_start') result.inputTokens = event.message.usage.input_tokens;
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use')
        blocks.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: '',
        });
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          result.text += event.delta.text;
          delta(event.delta.text);
        }
        if (event.delta.type === 'input_json_delta') {
          const block = blocks.get(event.index);
          if (block) block.json += event.delta.partial_json;
        }
      }
      if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index);
        if (block)
          result.calls.push({
            id: block.id,
            name: block.name,
            args: block.json ? JSON.parse(block.json) : {},
          });
      }
      if (event.type === 'message_delta') result.outputTokens = event.usage?.output_tokens;
    }
    return result;
  }
}
