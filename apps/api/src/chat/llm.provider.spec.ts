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
