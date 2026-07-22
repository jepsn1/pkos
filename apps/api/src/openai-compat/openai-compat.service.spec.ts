import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { attachmentUrl } from '../attachments/attachments.service';
import type { Citation } from '../chat/chat.repo';
import type { ChatService } from '../chat/chat.service';
import type { LlmMessage } from '../chat/llm.provider';
import {
  extractImageParts,
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
  const calls: Array<{
    message: string;
    history: LlmMessage[];
    think?: boolean | string;
    images?: unknown[];
  }> = [];
  const chat = {
    answer: async (
      message: string,
      history: LlmMessage[],
      onToken?: (token: string) => void,
      _onThinking?: (token: string) => void,
      _model?: string,
      think?: boolean | string,
      images?: unknown[],
    ) => {
      calls.push({ message, history, think, images });
      if (onToken) for (const t of tokens) onToken(t);
      return { answer, citations };
    },
  } as unknown as ChatService;
  return { service: new OpenAiCompatService(chat), calls };
}

/** A stand-in attachment store: records what it stored, returns a stable id. */
function attachmentsSpy() {
  const stored: Array<{ originalname: string; mimetype: string; size: number }> = [];
  const attachments = {
    store: async (file: { buffer: Buffer; originalname: string; mimetype: string }) => {
      stored.push({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.buffer.length,
      });
      return { id: 'att-1', mime: file.mimetype };
    },
  };
  return { attachments, stored };
}

describe('listModels', () => {
  it('exposes the reasoning-level presets, default (Fast) first, with plain names', () => {
    const { service } = serviceWith([]);
    const res = service.listModels();
    expect(res.object).toBe('list');
    expect(res.data.length).toBeGreaterThan(1);
    expect(res.data[0]).toMatchObject({ id: 'pkos-fast', object: 'model', name: 'Fast' });
    expect(res.data.map((m) => m.name)).toEqual(['Fast', 'Balanced', 'Deep']);
    for (const m of res.data) expect(m.id).toMatch(/^pkos-/);
  });
});

describe('reasoning-level selection', () => {
  it('maps the chosen preset to its think level and echoes the id back', async () => {
    const { service, calls } = serviceWith([]);
    const res = await service.complete({
      model: 'pkos-deep',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0].think).toBe('high');
    expect(res.model).toBe('pkos-deep');
  });

  it('falls back to the default preset (Fast/low) for a legacy/unknown id', async () => {
    const { service, calls } = serviceWith([]);
    const res = await service.complete({
      model: 'pkos',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0].think).toBe('low');
    expect(res.model).toBe('pkos-fast');
  });

  it('streaming applies the chosen think level too', async () => {
    const { service, calls } = serviceWith([]);
    const chunks: CompletionChunk[] = [];
    await service.streamCompletion(
      { model: 'pkos-balanced', messages: [{ role: 'user', content: 'hi' }] },
      (c) => chunks.push(c),
    );
    expect(calls[0].think).toBe('medium');
    expect(chunks[0].model).toBe('pkos-balanced');
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

describe('extractImageParts', () => {
  it('pulls base64 data-URI images from the last user message (both part shapes)', () => {
    const imgs = extractImageParts({
      messages: [
        { role: 'user', content: 'ignore this earlier one' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'make a note from this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: 'data:image/jpeg;base64,BBBB' },
          ],
        },
      ],
    });
    expect(imgs).toEqual([
      { mime: 'image/png', base64: 'AAAA' },
      { mime: 'image/jpeg', base64: 'BBBB' },
    ]);
  });

  it('ignores non-data URLs and text-only messages', () => {
    expect(
      extractImageParts({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
          },
        ],
      }),
    ).toEqual([]);
    expect(extractImageParts({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([]);
  });
});

describe('inline images → ChatService', () => {
  it('stores the original and passes {url,mime,base64} through to answer()', async () => {
    const { attachments, stored } = attachmentsSpy();
    const calls: Array<{ message: string; images?: unknown[] }> = [];
    const chat = {
      answer: async (
        message: string,
        _h: LlmMessage[],
        _t?: unknown,
        _th?: unknown,
        _model?: unknown,
        _think?: unknown,
        images?: unknown[],
      ) => {
        calls.push({ message, images });
        return { answer: 'saved', citations: [] };
      },
    } as unknown as ChatService;
    const service = new OpenAiCompatService(chat, undefined, attachments as never);

    await service.complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'make a note from this' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
          ],
        },
      ],
    });

    expect(stored).toEqual([{ originalname: 'image.jpg', mimetype: 'image/jpeg', size: 3 }]);
    expect(calls[0].images).toEqual([
      { url: attachmentUrl('att-1'), mime: 'image/jpeg', base64: 'QUJD' },
    ]);
    // the image rides along as an embeddable reference, and the model is told
    // NOT to invent its contents (vision is dormant)
    expect(calls[0].message).toContain(attachmentUrl('att-1'));
    expect(calls[0].message).toMatch(/never transcribe|use only what the user/i);
  });

  it('passes no images when the store is not configured', async () => {
    const { service, calls } = serviceWith([]);
    await service.complete({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    expect(calls[0].images).toEqual([]);
  });
});

describe('complete (ChatService → OpenAI translation)', () => {
  it('returns an OpenAI-shaped completion, answer only (no footer by default)', async () => {
    const { service, calls } = serviceWith([GRACE_CITATION]);
    const res = await service.complete({
      model: 'pkos',
      messages: [{ role: 'user', content: 'what have I collected about grace?' }],
    });

    expect(calls).toEqual([
      { message: 'what have I collected about grace?', history: [], think: 'low', images: [] },
    ]);
    expect(res.object).toBe('chat.completion');
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.model).toBe(MODEL_ID);
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0].finish_reason).toBe('stop');
    const content = res.choices[0].message.content;
    expect(content).toBe('Grace is unmerited favor.');
    expect(content).not.toContain('**Sources:**');
  });

  it('includes the footer when COMPAT_SOURCES_FOOTER=true', async () => {
    process.env.COMPAT_SOURCES_FOOTER = 'true';
    try {
      const { service } = serviceWith([GRACE_CITATION]);
      const res = await service.complete({
        messages: [{ role: 'user', content: 'grace?' }],
      });
      const content = res.choices[0].message.content;
      expect(content).toContain('**Sources:**');
      expect(content).toContain('faith/reflections/on-grace.md');
    } finally {
      delete process.env.COMPAT_SOURCES_FOOTER;
    }
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

  it('emits role chunk → one delta per token → stop (no footer by default)', async () => {
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
    // Voice-first default: tokens only, no spoken Sources footer.
    expect(deltas).toEqual(['Grace', ' is', ' unmerited', ' favor.']);
    expect(chunks.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
    const stop = chunks.at(-1)!;
    expect(stop.choices[0].finish_reason).toBe('stop');
    expect(stop.choices[0].delta).toEqual({});
  });

  it('appends the Sources footer delta when COMPAT_SOURCES_FOOTER=true', async () => {
    process.env.COMPAT_SOURCES_FOOTER = 'true';
    try {
      const { service } = serviceWith([GRACE_CITATION], 'Grace is unmerited favor.', [
        'Grace',
        ' is unmerited favor.',
      ]);
      const chunks = await collect(service);
      const deltas = chunks.slice(1, -1).map((c) => c.choices[0].delta.content);
      expect(deltas.at(-1)).toBe(
        '\n\n---\n**Sources:**\n- `faith/reflections/on-grace.md` — On Grace (0.72)',
      );
    } finally {
      delete process.env.COMPAT_SOURCES_FOOTER;
    }
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
    expect(chunks[1].choices[0].delta.content).toContain('pkos error:');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
  });
});
