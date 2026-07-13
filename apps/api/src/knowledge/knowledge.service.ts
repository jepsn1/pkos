import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import {
  KNOWLEDGE_REPO,
  type KnowledgeItem,
  type KnowledgeRepo,
  type SearchHit,
} from './knowledge.repo';
import { embeddingText, type Note } from './note';
import { VaultService } from './vault.service';
import {
  TRANSCRIPT_SEARCH,
  type SermonSearchHit,
  type TranscriptSearch,
} from '../sermons/sermons.repo';

/** /api/search result: knowledge item or sermon transcript chunk. */
export type UnifiedSearchHit =
  | (SearchHit & { type: 'knowledge' })
  | (SermonSearchHit & { type: 'sermon' });

export interface IngestRequest {
  title: string;
  markdown: string;
  source?: string;
  tags?: string[];
  summary?: string;
  importance?: number;
  /** Vault folder, e.g. faith/reflections. */
  folder?: string;
}

const DEFAULT_FOLDER = 'articles';
const DEFAULT_SEARCH_LIMIT = 10;

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly vault: VaultService,
    @Inject(KNOWLEDGE_REPO) private readonly repo: KnowledgeRepo,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    // Optional so knowledge tests need no sermon fake; absent -> knowledge-only.
    @Optional()
    @Inject(TRANSCRIPT_SEARCH)
    private readonly transcripts?: TranscriptSearch,
  ) {}

  /** Vault write + commit first (canonical), then derived row + embedding. */
  async ingest(req: IngestRequest): Promise<KnowledgeItem> {
    const note: Note = {
      meta: {
        title: req.title,
        source: req.source,
        tags: req.tags ?? [],
        summary: req.summary,
        importance: req.importance,
        created: new Date().toISOString().slice(0, 10),
      },
      body: req.markdown,
    };
    const relPath = await this.vault.writeNote(req.folder ?? DEFAULT_FOLDER, note);
    return this.index(relPath, note);
  }

  async list(): Promise<KnowledgeItem[]> {
    return this.repo.list();
  }

  /** Metadata row + canonical body read from the vault. */
  async get(id: string): Promise<KnowledgeItem & { body: string }> {
    const item = await this.repo.getById(id);
    if (!item) throw new NotFoundException(`no knowledge item ${id}`);
    const note = await this.vault.readNote(item.path);
    if (!note) throw new NotFoundException(`vault file missing: ${item.path}`);
    return { ...item, body: note.body };
  }

  /** Union of knowledge items and sermon transcript chunks, cosine-ranked. */
  async search(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<UnifiedSearchHit[]> {
    const embedding = await this.embedder.embed(query);
    const [items, chunks] = await Promise.all([
      this.repo.search(embedding, limit),
      this.transcripts?.search(embedding, limit) ?? Promise.resolve([]),
    ]);
    return [
      ...items.map((h) => ({ ...h, type: 'knowledge' as const })),
      ...chunks.map((h) => ({ ...h, type: 'sermon' as const })),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Wipe derived rows and re-derive everything from the vault. */
  async rebuild(): Promise<{ indexed: number }> {
    await this.repo.wipe();
    const notes = await this.vault.listNotes();
    for (const { path, note } of notes) {
      await this.index(path, note);
    }
    return { indexed: notes.length };
  }

  private async index(relPath: string, note: Note): Promise<KnowledgeItem> {
    const embedding = await this.embedder.embed(embeddingText(note));
    return this.repo.upsert({
      path: relPath,
      title: note.meta.title,
      source: note.meta.source ?? null,
      tags: note.meta.tags,
      summary: note.meta.summary ?? null,
      importance: note.meta.importance ?? null,
      created: note.meta.created,
      embedding,
    });
  }
}
