import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Citation } from '../chat/chat.repo';
import type { ChatService } from '../chat/chat.service';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';

const GRACE_CITATION: Citation = {
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  score: 0.72,
};

function fakeChat(tokens: string[], answer: string, citations: Citation[]): ChatService {
  return {
    answer: async (
      _message: string,
      _history: unknown,
      onToken?: (token: string) => void,
    ) => {
      if (onToken) for (const t of tokens) onToken(t);
      return { answer, citations };
    },
  } as unknown as ChatService;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  let ended = false;
  let flushed = false;
  let jsonBody: unknown;
  return {
    res: {
      setHeader: (n: string, v: string) => (headers[n] = v),
      flushHeaders: () => (flushed = true),
      write: (c: string) => writes.push(c),
      end: () => (ended = true),
      json: (b: unknown) => (jsonBody = b),
    },
    state: () => ({ headers, writes, ended, flushed, jsonBody }),
  };
}

describe('OpenAiCompatController SSE', () => {
  it('stream:true writes SSE headers, data: frames per chunk, then [DONE] and ends', async () => {
    const service = new OpenAiCompatService(
      fakeChat(['Grace', ' abounds.'], 'Grace abounds.', [GRACE_CITATION]),
    );
    const controller = new OpenAiCompatController(service);
    const { res, state } = fakeRes();

    await controller.completions(
      { stream: true, messages: [{ role: 'user', content: 'grace?' }] },
      res,
    );

    const { headers, writes, ended, flushed } = state();
    expect(flushed).toBe(true);
    expect(ended).toBe(true);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(writes.every((w) => w.startsWith('data: ') && w.endsWith('\n\n'))).toBe(true);
    expect(writes.at(-1)).toBe('data: [DONE]\n\n');
    // role, 2 tokens, footer, stop, [DONE]
    expect(writes).toHaveLength(6);
    const deltas = writes
      .slice(0, -1)
      .map((w) => JSON.parse(w.slice('data: '.length)).choices[0].delta);
    expect(deltas[0].role).toBe('assistant');
    expect(deltas[1].content).toBe('Grace');
    expect(deltas[2].content).toBe(' abounds.');
    expect(deltas[3].content).toContain('**Sources:**');
    expect(deltas[4]).toEqual({});
  });

  it('stream:true with a mid-stream error still terminates with [DONE]', async () => {
    const chat = {
      answer: async () => {
        throw new Error('ollama down');
      },
    } as unknown as ChatService;
    const controller = new OpenAiCompatController(new OpenAiCompatService(chat));
    const { res, state } = fakeRes();

    await controller.completions(
      { stream: true, messages: [{ role: 'user', content: 'grace?' }] },
      res,
    );

    const { writes, ended } = state();
    expect(ended).toBe(true);
    expect(writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(writes.join('')).toContain('[pkos error: ollama down]');
  });

  it('stream:true with a bad request 400s as JSON before any SSE bytes', async () => {
    const controller = new OpenAiCompatController(
      new OpenAiCompatService(fakeChat([], '', [])),
    );
    const { res, state } = fakeRes();

    await expect(
      controller.completions({ stream: true, messages: [] }, res),
    ).rejects.toThrow(BadRequestException);
    expect(state().writes).toEqual([]);
    expect(state().flushed).toBe(false);
  });

  it('stream:false returns the plain JSON completion', async () => {
    const controller = new OpenAiCompatController(
      new OpenAiCompatService(fakeChat(['x'], 'Grace abounds.', [])),
    );
    const { res, state } = fakeRes();

    await controller.completions(
      { messages: [{ role: 'user', content: 'grace?' }] },
      res,
    );

    const { jsonBody, writes } = state();
    expect(writes).toEqual([]);
    expect((jsonBody as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('Grace abounds.');
  });
});
