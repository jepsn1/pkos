import { afterEach, describe, expect, it } from 'vitest';
import { OllamaLlmProvider, stripThink, ThinkFilter } from './llm.provider';

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

/** Fake fetch whose response body is an async-iterable of encoded chunks (NDJSON stream). */
function fakeStreamFetch(chunks: string[], status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const enc = new TextEncoder();
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return {
      ok: status < 400,
      status,
      body: (async function* () {
        for (const c of chunks) yield enc.encode(c);
      })(),
    } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const line = (msg: Record<string, unknown>, done = false) =>
  `${JSON.stringify({ message: msg, done })}\n`;

describe('OllamaLlmProvider.chatStream', () => {
  it('POSTs stream:true, forwards each content delta, assembles the final reply', async () => {
    const { fn, calls } = fakeStreamFetch([
      line({ content: 'Grace' }),
      line({ content: ' is' }),
      line({ content: ' favor.' }),
      line({ content: '' }, true),
    ]);
    const tokens: string[] = [];
    const reply = await new OllamaLlmProvider(fn).chatStream(
      [{ role: 'user', content: 'grace?' }],
      undefined,
      (t) => tokens.push(t),
    );

    expect(tokens).toEqual(['Grace', ' is', ' favor.']);
    expect(reply).toEqual({ content: 'Grace is favor.', toolCalls: [] });
    const payload = JSON.parse(calls[0].init.body as string);
    expect(payload).toMatchObject({ stream: true, think: false, model: 'qwen3:14b' });
  });

  it('reassembles NDJSON lines split across network chunks', async () => {
    const full = line({ content: 'hello' }) + line({ content: ' world' }, true);
    const { fn } = fakeStreamFetch([full.slice(0, 17), full.slice(17, 30), full.slice(30)]);
    const tokens: string[] = [];
    const reply = await new OllamaLlmProvider(fn).chatStream([], undefined, (t) =>
      tokens.push(t),
    );
    expect(tokens).toEqual(['hello', ' world']);
    expect(reply.content).toBe('hello world');
  });

  it('collects tool_calls and goes silent after them (content kept in reply)', async () => {
    const { fn, calls } = fakeStreamFetch([
      line({
        content: '',
        tool_calls: [{ function: { name: 'log_workout', arguments: { notes: 'x' } } }],
      }),
      line({ content: 'post-tool prose' }),
      line({ content: '' }, true),
    ]);
    const tokens: string[] = [];
    const tools = [{ name: 'log_workout', description: 'd', parameters: {} }];
    const reply = await new OllamaLlmProvider(fn).chatStream(
      [{ role: 'user', content: 'bench 5x5' }],
      tools,
      (t) => tokens.push(t),
    );

    expect(tokens).toEqual([]); // nothing leaks once a tool round opened
    expect(reply).toEqual({
      content: 'post-tool prose',
      toolCalls: [{ name: 'log_workout', arguments: { notes: 'x' } }],
    });
    expect(JSON.parse(calls[0].init.body as string).tools).toEqual([
      { type: 'function', function: tools[0] },
    ]);
  });

  it('strips <think> from the assembled reply content', async () => {
    const { fn } = fakeStreamFetch([
      line({ content: '<think>hm</think>' }),
      line({ content: 'final' }, true),
    ]);
    const reply = await new OllamaLlmProvider(fn).chatStream([], undefined, () => {});
    expect(reply.content).toBe('final');
  });

  it('throws on HTTP errors and on in-stream error lines', async () => {
    await expect(
      new OllamaLlmProvider(fakeStreamFetch([], 500).fn).chatStream([], undefined, () => {}),
    ).rejects.toThrow('HTTP 500');
    await expect(
      new OllamaLlmProvider(
        fakeStreamFetch([`${JSON.stringify({ error: 'model exploded' })}\n`]).fn,
      ).chatStream([], undefined, () => {}),
    ).rejects.toThrow('model exploded');
  });
});

describe('ThinkFilter', () => {
  function run(deltas: string[]) {
    const out: string[] = [];
    const filter = new ThinkFilter((t) => out.push(t));
    for (const d of deltas) filter.push(d);
    const total = filter.end();
    return { out, total };
  }

  it('passes tokens through and total equals the concatenation', () => {
    const { out, total } = run(['Grace', ' is', ' favor.']);
    expect(out).toEqual(['Grace', ' is', ' favor.']);
    expect(total).toBe('Grace is favor.');
  });

  it('suppresses think blocks even when tags split across deltas', () => {
    const { out, total } = run(['<thi', 'nk>secret plan</th', 'ink>Hello', ' world']);
    expect(out.join('')).toBe('Hello world');
    expect(out.join('')).not.toContain('secret');
    expect(total).toBe('Hello world');
  });

  it('trims leading/trailing whitespace across deltas (matches stripThink)', () => {
    const { out, total } = run(['  ', ' Hello', ' world', '  \n']);
    expect(out.join('')).toBe('Hello world');
    expect(total).toBe(stripThink('   Hello world  \n'));
  });

  it('a lone "<" that never becomes a tag is real text', () => {
    const { total } = run(['a <thi', 'rd thing']);
    expect(total).toBe('a <third thing');
  });
});

describe('stripThink', () => {
  it('removes multiple think blocks and trims', () => {
    expect(stripThink('<think>a</think>x<think>b\nc</think> y')).toBe('x y');
    expect(stripThink('plain')).toBe('plain');
  });
});
