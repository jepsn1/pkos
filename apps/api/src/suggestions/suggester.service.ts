import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { LLM_PROVIDER, stripThink, toReply, type LlmProvider } from '../chat/llm.provider';
import { isRelationshipType, RELATIONSHIP_TYPES } from '../graph/relationship.repo';
import { KNOWLEDGE_REPO, type KnowledgeItem, type KnowledgeRepo } from '../knowledge/knowledge.repo';
import { KnowledgeService } from '../knowledge/knowledge.service';
import type { Note } from '../knowledge/note';
import { VaultService } from '../knowledge/vault.service';
import {
  SUGGESTION_REPO,
  type SimilarItem,
  type Suggestion,
  type SuggestionKind,
  type SuggestionRepo,
} from './suggestion.repo';

/** Cosine similarity at/above which a neighbor is flagged as a possible duplicate. */
export const DUPLICATE_THRESHOLD = 0.9;
/** Lower bound of the "related, worth linking" similarity band (upper = duplicate threshold). */
export const LINK_THRESHOLD = 0.65;
const NEIGHBOR_LIMIT = 10;
const MAX_TAGS = 5;

interface LlmOrganize {
  tags: string[];
  /** candidate path → relationship type the LLM proposed (validated). */
  linkTypes: Map<string, string>;
  summary?: string;
}

/**
 * Generates pending organization suggestions for a knowledge item (PRD
 * "AI-Assisted Organization"): duplicates + related links from embedding
 * neighbors, tags + summary from qwen3. Nothing is ever auto-applied — the
 * review API (SuggestionsService) is the only thing that applies them.
 * Hooks KnowledgeService.onIngested fire-and-forget: a suggester failure
 * never fails an ingest.
 */
@Injectable()
export class SuggesterService implements OnModuleInit {
  private readonly logger = new Logger(SuggesterService.name);

  constructor(
    @Inject(SUGGESTION_REPO) private readonly repo: SuggestionRepo,
    @Inject(KNOWLEDGE_REPO) private readonly knowledge: KnowledgeRepo,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly vault: VaultService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  onModuleInit() {
    this.knowledgeService.onIngested = (item) => {
      this.generate(item.id).catch((err: unknown) =>
        this.logger.error(`suggestion generation failed for ${item.path}: ${String(err)}`),
      );
    };
  }

  /** Compute + store pending suggestions for one item. Returns the created rows. */
  async generate(itemId: string): Promise<Suggestion[]> {
    const item = await this.knowledge.getById(itemId);
    if (!item) throw new NotFoundException(`no knowledge item ${itemId}`);
    const note = await this.vault.readNote(item.path);
    if (!note) throw new NotFoundException(`vault file missing: ${item.path}`);

    const neighbors = await this.repo.similarTo(itemId, NEIGHBOR_LIMIT);
    const linked = new Set((note.meta.relationships ?? []).map((r) => r.path));
    const duplicates = neighbors.filter((n) => n.score >= DUPLICATE_THRESHOLD);
    const linkCandidates = neighbors.filter(
      (n) => n.score >= LINK_THRESHOLD && n.score < DUPLICATE_THRESHOLD && !linked.has(n.path),
    );

    // Embedding-derived suggestions never depend on the LLM call succeeding.
    const llm = await this.askLlm(item, note, linkCandidates);

    const proposals: Array<{ kind: SuggestionKind; payload: Record<string, unknown> }> = [];
    for (const d of duplicates) {
      proposals.push({
        kind: 'duplicate',
        payload: { duplicateOfPath: d.path, similarity: Number(d.score.toFixed(4)) },
      });
    }
    for (const c of linkCandidates) {
      const proposed = llm?.linkTypes.get(c.path);
      proposals.push({
        kind: 'link',
        payload: { toPath: c.path, type: isRelationshipType(proposed) ? proposed : 'related_to' },
      });
    }
    for (const tag of llm?.tags ?? []) {
      proposals.push({ kind: 'tag', payload: { tag } });
    }
    if (!note.meta.summary && llm?.summary) {
      proposals.push({ kind: 'summary', payload: { summary: llm.summary } });
    }

    // Re-triggering must not pile up identical pending suggestions.
    const pending = await this.repo.listPendingByItem(itemId);
    const seen = new Set(pending.map((s) => `${s.kind}:${JSON.stringify(s.payload)}`));
    const created: Suggestion[] = [];
    for (const p of proposals) {
      const key = `${p.kind}:${JSON.stringify(p.payload)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      created.push(await this.repo.create(itemId, p.kind, p.payload));
    }
    return created;
  }

  /** One qwen3 call for tags + link types + summary. Null on any failure (logged). */
  private async askLlm(
    item: KnowledgeItem,
    note: Note,
    candidates: SimilarItem[],
  ): Promise<LlmOrganize | null> {
    try {
      const vocab = await this.repo.tagVocabulary();
      const reply = toReply(
        await this.llm.chat([{ role: 'user', content: this.prompt(note, vocab, candidates) }]),
      );
      const parsed = extractJson(stripThink(reply.content));
      if (!parsed) throw new Error('no JSON object in LLM reply');

      const existing = new Set(note.meta.tags.map((t) => t.toLowerCase()));
      const tags: string[] = [];
      for (const raw of Array.isArray(parsed.tags) ? parsed.tags : []) {
        if (typeof raw !== 'string') continue;
        const tag = raw.trim().toLowerCase();
        if (!tag || existing.has(tag) || tags.includes(tag)) continue;
        tags.push(tag);
        if (tags.length >= MAX_TAGS) break;
      }

      const linkTypes = new Map<string, string>();
      for (const l of Array.isArray(parsed.links) ? parsed.links : []) {
        if (l && typeof l === 'object') {
          const { path, type } = l as Record<string, unknown>;
          if (typeof path === 'string' && typeof type === 'string') linkTypes.set(path, type);
        }
      }

      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : undefined;
      return { tags, linkTypes, summary };
    } catch (err) {
      this.logger.error(`LLM organize call failed for ${item.path}: ${String(err)}`);
      return null;
    }
  }

  private prompt(note: Note, vocab: string[], candidates: SimilarItem[]): string {
    return [
      'You organize a personal markdown knowledge vault. Propose tags, link types, and a summary for a new note.',
      '',
      `New note "${note.meta.title}":`,
      '"""',
      note.body,
      '"""',
      '',
      `Existing tag vocabulary: ${vocab.join(', ') || '(empty)'}`,
      '',
      'Link candidates (existing notes semantically similar to the new note):',
      candidates.map((c) => `- ${c.path} — ${c.title}`).join('\n') || '(none)',
      '',
      'Answer with ONLY a JSON object, no prose, shaped exactly like:',
      '{"tags": ["..."], "links": [{"path": "...", "type": "..."}], "summary": "..."}',
      '',
      'Rules:',
      `- tags: up to ${MAX_TAGS} lowercase topical tags for the new note; reuse vocabulary tags when they fit, invent new ones only when necessary.`,
      `- links: one entry per candidate whose relationship to the new note is more specific than related_to; type must be one of: ${RELATIONSHIP_TYPES.join(', ')}. Omit candidates to leave them as related_to.`,
      '- summary: one sentence summarizing the new note.',
    ].join('\n');
  }
}

/** Pull the outermost {...} out of an LLM reply (models love wrapping JSON in prose/fences). */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
