import { NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type { KnowledgeRepo, SearchHit } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import type { ChatRepo, Conversation, Message, NewMessage } from './chat.repo';
import { ChatService, deriveTitle } from './chat.service';
import type { LlmMessage, LlmProvider } from './llm.provider';

/** Records every call; answers from a queue (falls back to a canned answer). */
class FakeLlm implements LlmProvider {
  calls: LlmMessage[][] = [];
  queue: string[] = [];

  async chat(messages: LlmMessage[]): Promise<string> {
    this.calls.push(messages);
    return this.queue.shift() ?? 'canned answer citing faith/reflections/on-grace.md';
  }
}

class FakeChatRepo implements ChatRepo {
  conversations: Conversation[] = [];
  messages: Message[] = [];
  private seq = 0;

  async createConversation(title: string): Promise<Conversation> {
    const now = new Date();
    const conv = { id: `conv-${++this.seq}`, title, created: now, updated: now };
    this.conversations.push(conv);
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find((c) => c.id === id) ?? null;
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations].sort(
      (a, b) => b.updated.getTime() - a.updated.getTime(),
    );
  }

  async touchConversation(id: string): Promise<void> {
    const conv = this.conversations.find((c) => c.id === id);
    if (conv) conv.updated = new Date();
  }

  async addMessage(msg: NewMessage): Promise<Message> {
    const row = { ...msg, id: `msg-${++this.seq}`, created: new Date() };
    this.messages.push(row);
    return row;
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }
}

/** Only `search` is exercised by ChatService. */
function knowledgeRepoWith(hits: SearchHit[]): KnowledgeRepo {
  return {
    search: async (_embedding: number[], limit: number) => hits.slice(0, limit),
    upsert: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    getById: () => Promise.reject(new Error('unused')),
    wipe: () => Promise.reject(new Error('unused')),
  };
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [1, 0, 0] };

const GRACE_HIT: SearchHit = {
  id: 'k1',
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  summary: 'Grace is unmerited favor.',
  score: 0.72,
};
const MERCY_HIT: SearchHit = {
  id: 'k2',
  path: 'faith/reflections/on-mercy.md',
  title: 'On Mercy',
  summary: 'Mercy withholds judgment.',
  score: 0.61,
};
const WEAK_HIT: SearchHit = { ...MERCY_HIT, id: 'k3', score: 0.43 };

let root: string;
let repo: FakeChatRepo;
let llm: FakeLlm;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-chat-'));
  await fs.mkdir(path.join(root, 'faith/reflections'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'faith/reflections/on-grace.md'),
    '---\ntitle: On Grace\ncreated: 2026-07-01\n---\n\nGrace is God’s unmerited favor, given freely.\n',
  );
  repo = new FakeChatRepo();
  llm = new FakeLlm();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeService(hits: SearchHit[]): ChatService {
  const vault = new VaultService(root, async () => {});
  return new ChatService(repo, knowledgeRepoWith(hits), fakeEmbedder, llm, vault);
}

describe('ChatService.chat', () => {
  it('persists user + assistant messages with citations and returns them', async () => {
    const service = makeService([GRACE_HIT, MERCY_HIT]);
    llm.queue.push('<think>hmm</think>Grace is unmerited favor (faith/reflections/on-grace.md).');

    const res = await service.chat('What have I collected about grace?');

    expect(res.answer).toBe('Grace is unmerited favor (faith/reflections/on-grace.md).');
    expect(res.citations).toEqual([
      { path: 'faith/reflections/on-grace.md', title: 'On Grace', score: 0.72 },
      { path: 'faith/reflections/on-mercy.md', title: 'On Mercy', score: 0.61 },
    ]);

    expect(repo.conversations).toHaveLength(1);
    expect(res.conversationId).toBe(repo.conversations[0].id);
    expect(repo.conversations[0].title).toBe('What have I collected about grace?');

    const stored = repo.messages;
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[0].content).toBe('What have I collected about grace?');
    expect(stored[0].citations).toBeNull();
    // <think> stripped from the stored answer too
    expect(stored[1].content).toBe(res.answer);
    expect(stored[1].citations).toEqual(res.citations);
  });

  it('grounds the system prompt in retrieved items (paths + vault bodies)', async () => {
    const service = makeService([GRACE_HIT]);
    await service.chat('grace?');

    const [system, user] = llm.calls[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('ONLY');
    expect(system.content).toContain('faith/reflections/on-grace.md');
    // body read from the vault, not just the db summary
    expect(system.content).toContain('unmerited favor, given freely');
    expect(user).toEqual({ role: 'user', content: 'grace?' });
  });

  it('below-threshold hits: empty citations + honest-answer instruction, no item leak', async () => {
    const service = makeService([WEAK_HIT]);

    const res = await service.chat('what do I know about quantum basket weaving');

    expect(res.citations).toEqual([]);
    expect(repo.messages[1].citations).toEqual([]);
    const system = llm.calls[0][0].content;
    expect(system).toContain('nothing relevant');
    expect(system).not.toContain('on-mercy.md');
  });

  it('continuation sends prior messages to the LLM and appends to the conversation', async () => {
    const service = makeService([GRACE_HIT]);
    llm.queue.push('first answer');
    const first = await service.chat('What is grace?');

    llm.queue.push('second answer');
    const second = await service.chat('Say more', first.conversationId);

    expect(second.conversationId).toBe(first.conversationId);
    const roles = llm.calls[1].map((m) => `${m.role}:${m.content}`);
    expect(roles).toEqual([
      expect.stringMatching(/^system:/),
      'user:What is grace?',
      'assistant:first answer',
      'user:Say more',
    ]);
    expect(repo.messages).toHaveLength(4);
    expect(repo.conversations).toHaveLength(1);
  });

  it('404s on unknown conversationId', async () => {
    const service = makeService([GRACE_HIT]);
    await expect(service.chat('hi', 'nope')).rejects.toThrow(NotFoundException);
  });
});

describe('ChatService conversations', () => {
  it('lists conversations and returns one with its messages', async () => {
    const service = makeService([GRACE_HIT]);
    const a = await service.chat('grace question');
    const b = await service.chat('another topic');

    const list = await service.listConversations();
    expect(list.map((c) => c.title).sort()).toEqual(['another topic', 'grace question']);

    const conv = await service.getConversation(a.conversationId);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0].role).toBe('user');

    await expect(service.getConversation('nope')).rejects.toThrow(NotFoundException);
    expect(b.conversationId).not.toBe(a.conversationId);
  });
});

describe('deriveTitle', () => {
  it('collapses whitespace and truncates long messages', () => {
    expect(deriveTitle('  hello\n world ')).toBe('hello world');
    const long = 'x'.repeat(200);
    expect(deriveTitle(long).length).toBe(80);
    expect(deriveTitle(long).endsWith('…')).toBe(true);
  });
});
