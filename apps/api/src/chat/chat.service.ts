import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { FitnessToolsService } from '../fitness/fitness-tools.service';
import {
  GRAPH_RETRIEVAL,
  relationLabel,
  type GraphNeighbor,
  type GraphRetrieval,
} from '../graph/graph.retrieval';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../knowledge/embedding.provider';
import { KnowledgeToolsService } from '../knowledge/knowledge-tools.service';
import { KNOWLEDGE_REPO, type KnowledgeRepo, type SearchHit } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import { MediaToolsService } from '../sermons/media-tools.service';
import { VisionToolsService } from '../vision/vision-tools.service';
import { WebSearchToolService } from '../web-search/web-search-tools.service';
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
  ThinkFilter,
  toReply,
  type LlmMessage,
  type LlmProvider,
  type LlmReply,
  type LlmTool,
  type LlmToolCall,
  type ThinkLevel,
} from './llm.provider';

/** An image attached to the current turn — stored (portable `url`) and ready for a
 *  vision model (`base64`, no data: prefix). Threaded into tool execution via ctx. */
export interface RequestImage {
  url: string;
  mime: string;
  base64: string;
}

/** Per-turn context handed to a tool at execution time (request-scoped data that
 *  isn't in the tool-call arguments). Only the vision toolset uses it today. */
export interface ToolContext {
  images: RequestImage[];
}

/** A service exposing LLM tools: definitions, executor, and routing rules. */
interface ToolSet {
  readonly tools: LlmTool[];
  routingPrompt(): string;
  execute(call: LlmToolCall, ctx?: ToolContext): Promise<string>;
}

export interface ChatResult {
  conversationId: string;
  answer: string;
  citations: Citation[];
}

const TOP_K = 5;
/** Cap on tool rounds per turn so a looping model can't spin forever. */
const MAX_TOOL_ROUNDS = 8;
/** Cosine cutoff below which retrieval counts as "nothing relevant" (nomic-embed:
 *  on-topic queries score ~0.6–0.75 here, nonsense tops out ~0.44). */
const DEFAULT_MIN_SCORE = 0.5;
const TITLE_MAX = 80;

const SYSTEM_BASE = `You are the user's personal knowledge assistant — you know their notes, their data, their history, and you talk like someone who does.
Voice: natural, warm, direct. Say "you're 180 cm tall", never "one metric has been logged for the user". Lead with the concrete facts and values; skip meta-talk about records, systems, or logging unless asked. No customer-service filler ("feel free to", "if you'd like to share more").
Grounding rules:
Answer the user's question using ONLY the knowledge items provided below where relevant.
When you draw on an item, refer to it by its TITLE in natural prose (e.g. "your note On Grace"). Never read out file paths, slashes, or ".md" — answers are often spoken aloud.
Keep answers concise and conversational — a few sentences unless asked for depth.
Do not invent notes, titles, or facts that are not in the provided items.
Broad questions about the user ("what do you know about me?") deserve a synthesized answer: pull their current metric values (via tools when available) AND what the knowledge items say about them, woven into prose — actual values and specifics, not an inventory of record types.`;

const SYSTEM_NO_HITS = `${SYSTEM_BASE}

No NEW knowledge item matched this specific message. If this is a follow-up to
something already discussed earlier in THIS conversation, just answer from what is
already there — NEVER claim you lack access to, or can't find, a note you have
already been talking about. Only when the topic is genuinely new AND has not come
up should you say plainly that the knowledge base has nothing on it (you may then
answer briefly from general knowledge, noting it's not from the vault). Never
fabricate notes or citations.`;

/**
 * Retrieval query = the last few conversation turns (truncated) + this message, so
 * a vague follow-up still re-retrieves the note under discussion. The current
 * message is included last; recent turns add topic anchors without an LLM rewrite.
 */
export function retrievalQuery(message: string, history: LlmMessage[]): string {
  const recent = history.slice(-3).map((m) => m.content.slice(0, 400));
  return [...recent, message].join('\n');
}

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
    @Optional() private readonly knowledgeTools?: KnowledgeToolsService,
    @Optional() private readonly webSearch?: WebSearchToolService,
    @Optional() private readonly mediaTools?: MediaToolsService,
    @Optional() private readonly visionTools?: VisionToolsService,
  ) {}

  /** Every tool-exposing service that is wired in (each is optional). */
  private toolsets(): ToolSet[] {
    const sets: Array<ToolSet | undefined> = [
      this.fitness,
      this.knowledgeTools,
      this.webSearch,
      this.mediaTools,
      // Vision is dormant by default: local VLMs that fit the 16GB card (7b) can't
      // reliably read pen marks / handwriting, and 32b is too slow. Attached images
      // are embedded as a reference instead (the model is told NOT to transcribe
      // them). Kept wired for re-enable via VISION_ENABLED once hardware allows.
      process.env.VISION_ENABLED === 'true' ? this.visionTools : undefined,
    ];
    return sets.filter((s): s is ToolSet => s !== undefined);
  }

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
   *
   * `onToken` (optional) streams the natural-language answer as it is generated:
   * tokens are think-filtered on the fly, tool rounds stay silent (the loop runs,
   * results are fed back, nothing is emitted until the model answers in prose),
   * and the returned/persisted `answer` equals the concatenation of the emitted
   * tokens. Without `onToken` behavior is exactly as before.
   */
  async answer(
    message: string,
    history: LlmMessage[] = [],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    model?: string,
    think?: ThinkLevel,
    images: RequestImage[] = [],
  ): Promise<{ answer: string; citations: Citation[] }> {
    // Retrieve on the recent conversation, not just this message: a vague
    // follow-up ("what else does it say?") embeds to nothing on its own, so the
    // note discussed a turn ago wouldn't re-surface and the model would wrongly
    // claim it lacks access. Recent turns re-anchor retrieval on the real topic.
    const embedding = await this.embedder.embed(retrievalQuery(message, history));
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
    const ctx: ToolContext = { images };
    // Planner: all wired toolsets (fitness, knowledge) are offered on every turn;
    // the system prompt routes matching turns to them, the rest stays on retrieval.
    const toolsets = this.toolsets();
    const tools = toolsets.length > 0 ? toolsets.flatMap((s) => s.tools) : undefined;
    // Streaming: one think-filter per LLM round, all filters share the emitted
    // accumulator — in practice tool rounds emit nothing (the provider silences
    // content once a tool_call appears), so `emitted` = the final prose round.
    const streaming = onToken && this.llm.chatStream;
    let emitted = '';
    const callLlm = async (): Promise<LlmReply> => {
      if (!streaming) return toReply(await this.llm.chat(llmMessages, tools, model, think));
      const filter = new ThinkFilter((t) => {
        emitted += t;
        onToken!(t);
      });
      const reply = await this.llm.chatStream!(
        llmMessages,
        tools,
        (tok) => filter.push(tok),
        onThinking,
        model,
        think,
      );
      filter.end();
      return reply;
    };
    let reply = await callLlm();
    for (
      let round = 0;
      toolsets.length > 0 && reply.toolCalls.length > 0 && round < MAX_TOOL_ROUNDS;
      round++
    ) {
      llmMessages.push({
        role: 'assistant',
        content: reply.content,
        toolCalls: reply.toolCalls,
      });
      for (const call of reply.toolCalls) {
        // Dispatch by tool name; unknown names land on the first set → {error}.
        const owner =
          toolsets.find((s) => s.tools.some((t) => t.name === call.name)) ?? toolsets[0];
        const result = await owner.execute(call, ctx);
        // Observability: tool routing is the main failure mode of small local
        // models — log every call verbatim so "it said no data" is debuggable.
        console.log(
          `[tool] ${call.name} args=${JSON.stringify(call.arguments)} -> ${result.slice(0, 200)}`,
        );
        llmMessages.push({
          role: 'tool',
          content: result,
          toolName: call.name,
        });
      }
      reply = await callLlm();
    }
    let answer: string;
    if (streaming) {
      answer = emitted;
    } else {
      answer = stripThink(reply.content);
      // Degraded streaming: provider without chatStream → whole answer as one token.
      if (onToken && answer) onToken(answer);
    }
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
    const routing = this.toolsets()
      .map((s) => `\n\n${s.routingPrompt()}`)
      .join('');
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
