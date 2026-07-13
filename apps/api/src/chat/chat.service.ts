import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { FitnessToolsService } from '../fitness/fitness-tools.service';
import {
  GRAPH_RETRIEVAL,
  relationLabel,
  type GraphNeighbor,
  type GraphRetrieval,
} from '../graph/graph.retrieval';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../knowledge/embedding.provider';
import { KNOWLEDGE_REPO, type KnowledgeRepo, type SearchHit } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import {
  CHAT_REPO,
  type ChatRepo,
  type Citation,
  type Conversation,
  type Message,
} from './chat.repo';
import {
  LLM_PROVIDER,
  stripThink,
  toReply,
  type LlmMessage,
  type LlmProvider,
} from './llm.provider';

export interface ChatResult {
  conversationId: string;
  answer: string;
  citations: Citation[];
}

const TOP_K = 5;
/** Cap on tool rounds per turn so a looping model can't spin forever. */
const MAX_TOOL_ROUNDS = 4;
/** Cosine cutoff below which retrieval counts as "nothing relevant" (nomic-embed:
 *  on-topic queries score ~0.6–0.75 here, nonsense tops out ~0.44). */
const DEFAULT_MIN_SCORE = 0.5;
const TITLE_MAX = 80;

const SYSTEM_BASE = `You are the assistant for a personal knowledge base of markdown notes.
Answer the user's question using ONLY the knowledge items provided below where relevant.
When you draw on an item, cite it by its path (e.g. faith/reflections/on-grace.md).
Do not invent notes, paths, or facts that are not in the provided items.`;

const SYSTEM_NO_HITS = `${SYSTEM_BASE}

No relevant knowledge items were found for this question. Say honestly that you found
nothing relevant in the knowledge base, and do not fabricate notes or citations. You may
still answer briefly from general knowledge if that is clearly helpful, but be explicit
that it does not come from the knowledge base.`;

@Injectable()
export class ChatService {
  constructor(
    @Inject(CHAT_REPO) private readonly repo: ChatRepo,
    @Inject(KNOWLEDGE_REPO) private readonly knowledge: KnowledgeRepo,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly vault: VaultService,
    @Inject(GRAPH_RETRIEVAL) private readonly graph: GraphRetrieval,
    @Optional() private readonly fitness?: FitnessToolsService,
  ) {}

  async chat(message: string, conversationId?: string): Promise<ChatResult> {
    let conversation: Conversation;
    let history: Message[] = [];
    if (conversationId) {
      const existing = await this.repo.getConversation(conversationId);
      if (!existing) throw new NotFoundException(`no conversation ${conversationId}`);
      conversation = existing;
      history = await this.repo.listMessages(conversationId);
    } else {
      conversation = await this.repo.createConversation(deriveTitle(message));
    }

    const { answer, citations } = await this.answer(
      message,
      history.map(({ role, content }): LlmMessage => ({ role, content })),
    );
    await this.repo.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: message,
      citations: null,
    });
    await this.repo.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer,
      citations,
    });
    await this.repo.touchConversation(conversation.id);

    return { conversationId: conversation.id, answer, citations };
  }

  /**
   * Stateless core: retrieval on `message` + grounded LLM answer with citations.
   * `history` is replayed to the LLM but nothing is persisted — callers that own
   * their own conversation state (e.g. the OpenAI-compat surface, where the client
   * resends full history every turn) use this directly.
   */
  async answer(
    message: string,
    history: LlmMessage[] = [],
  ): Promise<{ answer: string; citations: Citation[] }> {
    const embedding = await this.embedder.embed(message);
    const minScore = Number(process.env.RETRIEVAL_MIN_SCORE ?? DEFAULT_MIN_SCORE);
    const hits = (await this.knowledge.search(embedding, TOP_K)).filter(
      (h) => h.score >= minScore,
    );
    const citations: Citation[] = hits.map(({ path, title, score }) => ({
      path,
      title,
      score,
    }));

    // Graph-augmented retrieval: 1-hop neighbors of the hits join the context.
    const neighbors = await this.graph.neighbors(hits.map((h) => h.id));
    for (const n of neighbors) {
      if (citations.some((c) => c.path === n.path)) continue; // hit or earlier neighbor
      citations.push({ path: n.path, title: n.title, via: 'graph', relation: relationLabel(n) });
    }

    const llmMessages: LlmMessage[] = [
      { role: 'system', content: await this.systemPrompt(hits, neighbors) },
      ...history,
      { role: 'user', content: message },
    ];
    // Planner: fitness tools are offered on every turn; the system prompt routes
    // fitness statements/questions to them, everything else stays on retrieval.
    const tools = this.fitness?.tools;
    let reply = toReply(await this.llm.chat(llmMessages, tools));
    for (
      let round = 0;
      this.fitness && reply.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS;
      round++
    ) {
      llmMessages.push({
        role: 'assistant',
        content: reply.content,
        toolCalls: reply.toolCalls,
      });
      for (const call of reply.toolCalls) {
        llmMessages.push({
          role: 'tool',
          content: await this.fitness.execute(call),
          toolName: call.name,
        });
      }
      reply = toReply(await this.llm.chat(llmMessages, tools));
    }
    const answer = stripThink(reply.content);
    return { answer, citations };
  }

  async listConversations(): Promise<Conversation[]> {
    return this.repo.listConversations();
  }

  async getConversation(id: string): Promise<Conversation & { messages: Message[] }> {
    const conversation = await this.repo.getConversation(id);
    if (!conversation) throw new NotFoundException(`no conversation ${id}`);
    const messages = await this.repo.listMessages(id);
    return { ...conversation, messages };
  }

  /** Retrieval hits + their graph neighbors rendered with vault bodies for grounding. */
  private async systemPrompt(hits: SearchHit[], neighbors: GraphNeighbor[] = []): Promise<string> {
    const routing = this.fitness ? `\n\n${this.fitness.routingPrompt()}` : '';
    if (hits.length === 0) return `${SYSTEM_NO_HITS}${routing}`;
    const items = await Promise.all(
      hits.map(async (h, i) => {
        const note = await this.vault.readNote(h.path);
        const body = note?.body ?? h.summary ?? '';
        return `[${i + 1}] path: ${h.path}\ntitle: ${h.title}\n${body}`;
      }),
    );
    let prompt = `${SYSTEM_BASE}${routing}\n\nKnowledge items:\n\n${items.join('\n\n---\n\n')}`;
    if (neighbors.length > 0) {
      const hitPaths = new Set(hits.map((h) => h.path));
      const linked = await Promise.all(
        neighbors.map(async (n, i) => {
          const body = hitPaths.has(n.path)
            ? '(full note shown above)'
            : ((await this.vault.readNote(n.path))?.body ?? n.summary ?? '');
          return `[G${i + 1}] ${relationLabel(n)}: ${n.title} (${n.path}) — linked to ${n.of}\n${body}`;
        }),
      );
      prompt += `\n\nGraph-linked items (explicitly connected to the notes above; each is labeled with its relationship type):\n\n${linked.join('\n\n---\n\n')}`;
    }
    return prompt;
  }
}

export function deriveTitle(message: string): string {
  const oneLine = message.trim().replace(/\s+/g, ' ');
  return oneLine.length <= TITLE_MAX ? oneLine : `${oneLine.slice(0, TITLE_MAX - 1)}…`;
}
