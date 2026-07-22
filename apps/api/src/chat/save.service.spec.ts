import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type {
  KnowledgeItem,
  KnowledgeRepo,
  NewKnowledgeItem,
} from '../knowledge/knowledge.repo';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { VaultService } from '../knowledge/vault.service';
import type {
  ChatRepo,
  Conversation,
  ConversationListItem,
  Message,
  NewMessage,
} from './chat.repo';
import type { LlmMessage, LlmProvider } from './llm.provider';
import { parseDistilled, SaveService } from './save.service';

class FakeLlm implements LlmProvider {
  calls: LlmMessage[][] = [];
  queue: string[] = [];

  async chat(messages: LlmMessage[]): Promise<string> {
    this.calls.push(messages);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeLlm queue empty');
    return next;
  }
}

class FakeChatRepo implements ChatRepo {
  conversations: Conversation[] = [];
  messages: Message[] = [];
  private seq = 0;

  async createConversation(title: string): Promise<Conversation> {
    const now = new Date();
    const conv = {
      id: `conv-${++this.seq}`,
      title,
      created: now,
      updated: now,
      savedItemId: null,
    };
    this.conversations.push(conv);
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find((c) => c.id === id) ?? null;
  }

  async listConversations(): Promise<ConversationListItem[]> {
    return this.conversations.map((c) => ({ ...c, savedPath: null }));
  }

  async touchConversation(): Promise<void> {}

  async setSavedItem(conversationId: string, itemId: string): Promise<void> {
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (conv) conv.savedItemId = itemId;
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

class FakeKnowledgeRepo implements KnowledgeRepo {
  items: KnowledgeItem[] = [];
  private seq = 0;

  async upsert(item: NewKnowledgeItem): Promise<KnowledgeItem> {
    const { embedding: _e, ...meta } = item;
    const existing = this.items.find((i) => i.path === item.path);
    if (existing) {
      Object.assign(existing, meta, { updated: new Date() });
      return existing;
    }
    const row = { ...meta, id: `k-${++this.seq}`, updated: new Date() };
    this.items.push(row);
    return row;
  }

  async getById(id: string): Promise<KnowledgeItem | null> {
    return this.items.find((i) => i.id === id) ?? null;
  }

  async move(id: string, path: string): Promise<KnowledgeItem | null> {
    const item = this.items.find((i) => i.id === id);
    if (item) item.path = path;
    return item ?? null;
  }

  async list(): Promise<KnowledgeItem[]> {
    return this.items;
  }

  search(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  wipe(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [1, 0, 0] };

const DISTILL_JSON = JSON.stringify({
  title: 'Grace and Mercy Distinguished',
  summary: 'Grace gives unmerited favor; mercy withholds deserved judgment.',
  tags: ['faith', 'grace', 'mercy'],
  markdown: '## Key insight\n\nGrace gives; mercy withholds.\n\n## Conclusion\n\nBoth flow from love.',
});

let root: string;
let repo: FakeChatRepo;
let knowledgeRepo: FakeKnowledgeRepo;
let llm: FakeLlm;
let gitCalls: string[][];
let service: SaveService;
let vault: VaultService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-save-'));
  repo = new FakeChatRepo();
  knowledgeRepo = new FakeKnowledgeRepo();
  llm = new FakeLlm();
  gitCalls = [];
  vault = new VaultService(root, async (args) => {
    gitCalls.push(args);
  });
  const knowledge = new KnowledgeService(vault, knowledgeRepo, fakeEmbedder);
  service = new SaveService(repo, knowledgeRepo, llm, knowledge);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Conversation with a full user/assistant exchange; returns its id. */
async function seedConversation(): Promise<string> {
  const conv = await repo.createConversation('grace vs mercy');
  await repo.addMessage({
    conversationId: conv.id,
    role: 'user',
    content: 'What is the difference between grace and mercy?',
    citations: null,
  });
  await repo.addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: 'Grace gives unmerited favor; mercy withholds deserved judgment.',
    citations: [{ path: 'faith/on-grace.md', title: 'On Grace', score: 0.7 }],
  });
  await repo.addMessage({
    conversationId: conv.id,
    role: 'user',
    content: 'So mercy is the negative side of the same coin?',
    citations: null,
  });
  return conv.id;
}

describe('SaveService.save', () => {
  it('sends ALL conversation messages to the distill LLM', async () => {
    const id = await seedConversation();
    llm.queue.push(DISTILL_JSON);

    await service.save(id);

    expect(llm.calls).toHaveLength(1);
    const [system, user] = llm.calls[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('JSON');
    expect(user.role).toBe('user');
    expect(user.content).toContain('What is the difference between grace and mercy?');
    expect(user.content).toContain('Grace gives unmerited favor; mercy withholds');
    expect(user.content).toContain('So mercy is the negative side of the same coin?');
  });

  it('creates the vault article: frontmatter w/ provenance source, distilled body, git commit, db row, pointer', async () => {
    const id = await seedConversation();
    llm.queue.push(DISTILL_JSON);

    const res = await service.save(id);

    expect(res).toEqual({
      itemId: 'k-1',
      path: 'conversations/Grace and Mercy Distinguished.md',
      title: 'Grace and Mercy Distinguished',
    });

    // vault file with frontmatter incl. source: conversation:<id>
    const raw = await fs.readFile(path.join(root, res.path), 'utf8');
    const note = await vault.readNote(res.path);
    expect(note?.meta.source).toBe(`conversation:${id}`);
    expect(note?.meta.summary).toBe(
      'Grace gives unmerited favor; mercy withholds deserved judgment.',
    );
    expect(raw).toContain('title: Grace and Mercy Distinguished');
    expect(raw).toContain('## Key insight');
    expect(raw).toContain('## Conclusion');
    expect(raw).not.toContain('user:'); // article, not transcript

    // committed
    expect(gitCalls).toContainEqual(['add', res.path]);
    expect(gitCalls).toContainEqual(['commit', '-m', `add ${res.path}`]);

    // db row (embedded) + conversation pointer
    const item = await knowledgeRepo.getById(res.itemId);
    expect(item?.source).toBe(`conversation:${id}`);
    expect(item?.tags).toEqual(['faith', 'grace', 'mercy']);
    const conv = await repo.getConversation(id);
    expect(conv?.savedItemId).toBe(res.itemId);
  });

  it('honors a custom folder', async () => {
    const id = await seedConversation();
    llm.queue.push(DISTILL_JSON);

    const res = await service.save(id, { folder: 'faith/conversations' });

    expect(res.path).toBe('faith/conversations/Grace and Mercy Distinguished.md');
  });

  it('409s on resave with the existing path; conversation untouched', async () => {
    const id = await seedConversation();
    llm.queue.push(DISTILL_JSON);
    const first = await service.save(id);

    const err = await service.save(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.path).toBe(first.path);
    expect(body.itemId).toBe(first.itemId);

    expect(llm.calls).toHaveLength(1); // no second distill
    expect((await repo.getConversation(id))?.savedItemId).toBe(first.itemId);
  });

  it('force:true re-distills into a NEW suffixed file and moves the pointer', async () => {
    const id = await seedConversation();
    llm.queue.push(DISTILL_JSON, DISTILL_JSON);
    const first = await service.save(id);

    const second = await service.save(id, { force: true });

    expect(second.path).toBe('conversations/Grace and Mercy Distinguished-2.md');
    expect(second.itemId).not.toBe(first.itemId);
    expect((await repo.getConversation(id))?.savedItemId).toBe(second.itemId);
    // both files exist — vault history is append-only
    await fs.access(path.join(root, first.path));
    await fs.access(path.join(root, second.path));
  });

  it('404s on unknown conversation', async () => {
    await expect(service.save('nope')).rejects.toThrow(NotFoundException);
  });

  it('400s on a conversation with no messages', async () => {
    const conv = await repo.createConversation('empty');
    await expect(service.save(conv.id)).rejects.toThrow(BadRequestException);
  });
});

describe('parseDistilled', () => {
  it('tolerates code fences and prose around the JSON', () => {
    const d = parseDistilled('Sure!\n```json\n' + DISTILL_JSON + '\n```\nDone.');
    expect(d.title).toBe('Grace and Mercy Distinguished');
    expect(d.tags).toEqual(['faith', 'grace', 'mercy']);
  });

  it('throws on non-JSON and on missing title/markdown', () => {
    expect(() => parseDistilled('no json here')).toThrow(/not usable JSON/);
    expect(() => parseDistilled('{"title":"x"}')).toThrow(/not usable JSON/);
    expect(() => parseDistilled('{"markdown":"x"}')).toThrow(/not usable JSON/);
  });
});
