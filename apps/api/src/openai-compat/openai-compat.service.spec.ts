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
} from './openai-compat.service';

const GRACE_CITATION: Citation = {
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  score: 0.72,
};

/** Records answer() calls; returns a fixed grounded answer. */
function serviceWith(citations: Citation[], answer = 'Grace is unmerited favor.') {
  const calls: Array<{ message: string; history: LlmMessage[] }> = [];
  const chat = {
    answer: async (message: string, history: LlmMessage[]) => {
      calls.push({ message, history });
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

describe('completeChunks (stream translation)', () => {
  it('emits role chunk, content chunk with footer, stop chunk', async () => {
    const { service } = serviceWith([GRACE_CITATION]);
    const chunks = await service.completeChunks({
      messages: [{ role: 'user', content: 'grace?' }],
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.every((c) => c.id === chunks[0].id)).toBe(true);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks[1].choices[0].delta.content).toContain('Grace is unmerited favor.');
    expect(chunks[1].choices[0].delta.content).toContain('**Sources:**');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
  });
});
