import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Citation } from '../chat/chat.repo';
import type { ChatService } from '../chat/chat.service';
import type { LlmMessage } from '../chat/llm.provider';
import {
  MODEL_ID,
  OpenAiCompatService,
  parseMessages,
  withSources,
  type CompletionChunk,
} from './openai-compat.service';

const GRACE_CITATION: Citation = {
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  score: 0.72,
};

/** Records answer() calls; streams `tokens` through onToken; returns a grounded answer. */
function serviceWith(
  citations: Citation[],
  answer = 'Grace is unmerited favor.',
  tokens: string[] = [answer],
) {
  const calls: Array<{ message: string; history: LlmMessage[] }> = [];
  const chat = {
    answer: async (
      message: string,
      history: LlmMessage[],
      onToken?: (token: string) => void,
    ) => {
      calls.push({ message, history });
      if (onToken) for (const t of tokens) onToken(t);
      return { answer, citations };
    },
  } as unknown as ChatService;
  return { service: new OpenAiCompatService(chat), calls };
}

describe('listModels', () => {
  it('exposes exactly one model, id "pkos"', () => {
    const { service } = serviceWith([]);
    const res = service.listModels();
    expect(res.object).toBe('list');
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ id: 'pkos', object: 'model' });
  });
});

describe('parseMessages (OpenAI → ChatService translation)', () => {
  it('uses last user message for retrieval, prior turns as history', () => {
    const { message, history } = parseMessages({
      messages: [
        { role: 'system', content: 'client system prompt' },
        { role: 'user', content: 'what is grace?' },
        { role: 'assistant', content: 'Grace is unmerited favor.' },
        { role: 'user', content: 'and mercy?' },
      ],
    });
    expect(message).toBe('and mercy?');
    // client system prompt dropped — grounding owns the system slot
    expect(history).toEqual([
      { role: 'user', content: 'what is grace?' },
      { role: 'assistant', content: 'Grace is unmerited favor.' },
    ]);
  });

  it('flattens array-of-parts content to text', () => {
    const { message } = parseMessages({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'grace?' }] }],
    });
    expect(message).toBe('grace?');
  });

  it('rejects missing messages and no user message', () => {
    expect(() => parseMessages({} as never)).toThrow(BadRequestException);
    expect(() => parseMessages({ messages: [] })).toThrow(BadRequestException);
    expect(() =>
      parseMessages({ messages: [{ role: 'assistant', content: 'hi' }] }),
    ).toThrow(BadRequestException);
  });
});

describe('complete (ChatService → OpenAI translation)', () => {
  it('returns an OpenAI-shaped completion with citations footer', async () => {
    const { service, calls } = serviceWith([GRACE_CITATION]);
    const res = await service.complete({
      model: 'pkos',
      messages: [{ role: 'user', content: 'what have I collected about grace?' }],
    });

    expect(calls).toEqual([
      { message: 'what have I collected about grace?', history: [] },
    ]);
    expect(res.object).toBe('chat.completion');
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.model).toBe(MODEL_ID);
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0].finish_reason).toBe('stop');
    const content = res.choices[0].message.content;
    expect(content).toContain('Grace is unmerited favor.');
    expect(content).toContain('**Sources:**');
    expect(content).toContain('faith/reflections/on-grace.md');
    expect(content).toContain('(0.72)');
  });

  it('omits the Sources footer when there are no citations', async () => {
    const { service } = serviceWith([], 'Nothing relevant in the knowledge base.');
    const res = await service.complete({
      messages: [{ role: 'user', content: 'quantum basket weaving?' }],
    });
    expect(res.choices[0].message.content).toBe(
      'Nothing relevant in the knowledge base.',
    );
  });
});

describe('withSources', () => {
  it('appends one markdown line per citation', () => {
    const out = withSources('answer', [
      GRACE_CITATION,
      { path: 'faith/reflections/on-mercy.md', title: 'On Mercy', score: 0.61 },
    ]);
    expect(out).toBe(
      'answer\n\n---\n**Sources:**\n' +
        '- `faith/reflections/on-grace.md` — On Grace (0.72)\n' +
        '- `faith/reflections/on-mercy.md` — On Mercy (0.61)',
    );
  });
});

describe('streamCompletion (real token streaming)', () => {
  async function collect(service: OpenAiCompatService, body = {
    messages: [{ role: 'user', content: 'grace?' }],
  }) {
    const chunks: CompletionChunk[] = [];
    await service.streamCompletion(body, (c) => chunks.push(c));
    return chunks;
  }

  it('emits role chunk → one delta per token → sources footer delta → stop', async () => {
    const { service } = serviceWith(
      [GRACE_CITATION],
      'Grace is unmerited favor.',
      ['Grace', ' is', ' unmerited', ' favor.'],
    );
    const chunks = await collect(service);

    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.every((c) => c.id === chunks[0].id)).toBe(true);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const deltas = chunks.slice(1, -1).map((c) => c.choices[0].delta.content);
    expect(deltas).toEqual([
      'Grace',
      ' is',
      ' unmerited',
      ' favor.',
      '\n\n---\n**Sources:**\n- `faith/reflections/on-grace.md` — On Grace (0.72)',
    ]);
    // everything before the stop chunk is finish_reason:null
    expect(chunks.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
    const stop = chunks.at(-1)!;
    expect(stop.choices[0].finish_reason).toBe('stop');
    expect(stop.choices[0].delta).toEqual({});
  });

  it('omits the footer delta when there are no citations', async () => {
    const { service } = serviceWith([], 'Nothing relevant.', ['Nothing', ' relevant.']);
    const chunks = await collect(service);
    expect(chunks.map((c) => c.choices[0].delta.content)).toEqual([
      '',
      'Nothing',
      ' relevant.',
      undefined,
    ]);
  });

  it('turns a mid-stream failure into an error delta followed by the stop chunk', async () => {
    const chat = {
      answer: async () => {
        throw new Error('ollama down');
      },
    } as unknown as ChatService;
    const service = new OpenAiCompatService(chat);
    const chunks: CompletionChunk[] = [];
    await service.streamCompletion(
      { messages: [{ role: 'user', content: 'grace?' }] },
      (c) => chunks.push(c),
    );

    expect(chunks).toHaveLength(3); // role, error delta, stop — never hangs
    expect(chunks[1].choices[0].delta.content).toContain('[pkos error: ollama down]');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
  });
});
