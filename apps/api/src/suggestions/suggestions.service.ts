import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GraphService } from '../graph/graph.service';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../knowledge/embedding.provider';
import { KNOWLEDGE_REPO, type KnowledgeItem, type KnowledgeRepo } from '../knowledge/knowledge.repo';
import { embeddingText, type Note } from '../knowledge/note';
import { VaultService } from '../knowledge/vault.service';
import {
  isSuggestionStatus,
  SUGGESTION_REPO,
  SUGGESTION_STATUSES,
  type Suggestion,
  type SuggestionRepo,
  type SuggestionWithItem,
} from './suggestion.repo';

/**
 * Review API for AI organization suggestions. The user decides: accept applies
 * the change through the existing canonical-vault-first paths (VaultService
 * update / GraphService edge), reject only marks the row. Duplicate
 * suggestions are informational — accepting never merges or deletes anything.
 */
@Injectable()
export class SuggestionsService {
  constructor(
    @Inject(SUGGESTION_REPO) private readonly repo: SuggestionRepo,
    @Inject(KNOWLEDGE_REPO) private readonly knowledge: KnowledgeRepo,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    private readonly vault: VaultService,
    private readonly graph: GraphService,
  ) {}

  async list(status?: string): Promise<SuggestionWithItem[]> {
    if (status !== undefined && !isSuggestionStatus(status)) {
      throw new BadRequestException(`status must be one of: ${SUGGESTION_STATUSES.join(', ')}`);
    }
    return this.repo.list(status);
  }

  /** Apply the suggested change, then mark accepted. */
  async accept(id: string): Promise<Suggestion> {
    const s = await this.getPending(id);
    await this.apply(s);
    return this.markResolved(id, 'accepted');
  }

  /** Mark rejected; applies nothing. */
  async reject(id: string): Promise<Suggestion> {
    await this.getPending(id);
    return this.markResolved(id, 'rejected');
  }

  private async apply(s: Suggestion): Promise<void> {
    switch (s.kind) {
      case 'duplicate':
        // Informational only — the user handles any merge by hand in the vault.
        return;
      case 'link': {
        const { toPath, type } = s.payload;
        if (typeof toPath !== 'string' || typeof type !== 'string') {
          throw new BadRequestException(`malformed link payload on suggestion ${s.id}`);
        }
        try {
          await this.graph.createEdge({ fromId: s.itemId, toPath, type });
        } catch (err) {
          // Edge already there (e.g. created manually since) — accepting is a no-op.
          if (!(err instanceof ConflictException)) throw err;
        }
        return;
      }
      case 'tag': {
        const tag = s.payload.tag;
        if (typeof tag !== 'string' || !tag.trim()) {
          throw new BadRequestException(`malformed tag payload on suggestion ${s.id}`);
        }
        const { item, note } = await this.itemNote(s.itemId);
        if (!note.meta.tags.includes(tag)) {
          note.meta.tags = [...note.meta.tags, tag];
          await this.vault.updateNote(item.path, note, `tag ${item.path}: +${tag} (accepted suggestion)`);
        }
        await this.repo.updateItemMeta(s.itemId, { tags: note.meta.tags });
        return;
      }
      case 'summary': {
        const summary = s.payload.summary;
        if (typeof summary !== 'string' || !summary.trim()) {
          throw new BadRequestException(`malformed summary payload on suggestion ${s.id}`);
        }
        const { item, note } = await this.itemNote(s.itemId);
        note.meta.summary = summary;
        await this.vault.updateNote(item.path, note, `summary ${item.path} (accepted suggestion)`);
        // Embeddings include the summary — keep the derived row in sync.
        const embedding = await this.embedder.embed(embeddingText(note));
        await this.repo.updateItemMeta(s.itemId, { summary, embedding });
        return;
      }
    }
  }

  private async getPending(id: string): Promise<Suggestion> {
    const s = await this.repo.getById(id);
    if (!s) throw new NotFoundException(`no suggestion ${id}`);
    if (s.status !== 'pending') {
      throw new ConflictException(`suggestion ${id} already ${s.status}`);
    }
    return s;
  }

  private async markResolved(id: string, status: 'accepted' | 'rejected'): Promise<Suggestion> {
    const row = await this.repo.resolve(id, status);
    // Raced with another resolve between the check and the update.
    if (!row) throw new ConflictException(`suggestion ${id} already resolved`);
    return row;
  }

  private async itemNote(itemId: string): Promise<{ item: KnowledgeItem; note: Note }> {
    const item = await this.knowledge.getById(itemId);
    if (!item) throw new NotFoundException(`no knowledge item ${itemId}`);
    const note = await this.vault.readNote(item.path);
    if (!note) throw new NotFoundException(`vault file missing: ${item.path}`);
    return { item, note };
  }
}
