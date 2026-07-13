import { afterEach, describe, expect, it } from 'vitest';
import { OllamaLlmProvider, stripThink } from './llm.provider';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

afterEach(() => {
  delete process.env.LLM_MODEL;
});

describe('OllamaLlmProvider', () => {
  it('POSTs messages to /api/chat with think:false and returns the content', async () => {
    const { fn, calls } = fakeFetch(200, { message: { content: 'hi there' } });
    const provider = new OllamaLlmProvider(fn);

    const answer = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(answer).toBe('hi there');
    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(calls[0].init.body as string);
    expect(payload).toMatchObject({
      model: 'qwen3:14b',
      stream: false,
      think: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('honors LLM_MODEL and strips <think> blocks', async () => {
    process.env.LLM_MODEL = 'qwen3:8b';
    const { fn, calls } = fakeFetch(200, {
      message: { content: '<think>reasoning</think>  final ' },
    });
    const answer = await new OllamaLlmProvider(fn).chat([{ role: 'user', content: 'q' }]);
    expect(answer).toBe('final');
    expect(JSON.parse(calls[0].init.body as string).model).toBe('qwen3:8b');
  });

  it('with tools: sends ollama-native tools + tool messages, returns LlmReply with tool_calls', async () => {
    const { fn, calls } = fakeFetch(200, {
      message: {
        content: '',
        tool_calls: [{ function: { name: 'log_workout', arguments: { notes: 'x' } } }],
      },
    });
    const provider = new OllamaLlmProvider(fn);
    const tools = [
      { name: 'log_workout', description: 'log it', parameters: { type: 'object' } },
    ];

    const reply = await provider.chat(
      [
        { role: 'user', content: 'bench 5x5' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'log_workout', arguments: { notes: 'x' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolName: 'log_workout' },
      ],
      tools,
    );

    expect(reply).toEqual({
      content: '',
      toolCalls: [{ name: 'log_workout', arguments: { notes: 'x' } }],
    });
    const payload = JSON.parse(calls[0].init.body as string);
    expect(payload.tools).toEqual([{ type: 'function', function: tools[0] }]);
    expect(payload.messages[1].tool_calls).toEqual([
      { function: { name: 'log_workout', arguments: { notes: 'x' } } },
    ]);
    expect(payload.messages[2]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_name: 'log_workout',
    });
  });

  it('with tools but no tool_calls: LlmReply with empty toolCalls, no throw on content', async () => {
    const { fn } = fakeFetch(200, { message: { content: 'plain answer' } });
    const reply = await new OllamaLlmProvider(fn).chat(
      [{ role: 'user', content: 'q' }],
      [{ name: 't', description: 'd', parameters: {} }],
    );
    expect(reply).toEqual({ content: 'plain answer', toolCalls: [] });
  });

  it('throws on HTTP errors and on empty content', async () => {
    await expect(
      new OllamaLlmProvider(fakeFetch(500, {}).fn).chat([{ role: 'user', content: 'q' }]),
    ).rejects.toThrow('HTTP 500');
    await expect(
      new OllamaLlmProvider(fakeFetch(200, { message: { content: '' } }).fn).chat([
        { role: 'user', content: 'q' },
      ]),
    ).rejects.toThrow('no content');
  });
});

describe('stripThink', () => {
  it('removes multiple think blocks and trims', () => {
    expect(stripThink('<think>a</think>x<think>b\nc</think> y')).toBe('x y');
    expect(stripThink('plain')).toBe('plain');
  });
});
