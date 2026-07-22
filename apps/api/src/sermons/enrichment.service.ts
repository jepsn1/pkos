import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  LLM_PROVIDER,
  stripThink,
  toReply,
  type GenOptions,
  type LlmProvider,
  type ThinkLevel,
} from '../chat/llm.provider';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { slugify } from '../knowledge/note';
import { SERMON_REPO, type SermonJob, type SermonRepo } from './sermons.repo';

export const ENRICH_POLL_MS = 'ENRICH_POLL_MS';

/** What the enrichment LLM must produce for one transcript. */
export interface Enrichment {
  title: string;
  summary: string;
  /** Main points, each with a heading + detailed notes (study notes, not labels). */
  sections: { heading: string; notes: string[] }[];
  bibleReferences: string[];
  actionPoints: string[];
  keyQuotes: string[];
  tags: string[];
}

export interface EnrichResult {
  itemId: string;
  path: string;
  title: string;
}

/** Shared handling for live-interpreted (two-language) talks — appended to the
 *  JSON enrichment prompts so a bilingual transcript doesn't produce duplicated
 *  points and fragmentary quotes. */
const BILINGUAL = `

LANGUAGE: Write the ENTIRE note — summary, section notes, action points, AND key_quotes — in ENGLISH. If the audio is live-interpreted (statements repeated in two languages by an interpreter), collapse each repeated statement to ONE point (never output the same idea twice) and use the ENGLISH version for everything — the interpreter's English if present, otherwise translate faithfully. Never leave Danish (or other non-English) text in the note. Every key_quote must be a complete, meaningful English sentence, never a short repeated fragment.`;

const ENRICH_SYSTEM = `You are a careful note-taker turning a sermon transcript into DETAILED study notes for a personal knowledge base. Capture what was actually preached — never invent content.

Produce thorough NOTES, not a thin summary:
- "sections" are the main points of the sermon, in order. For each, a short heading AND 2-5 bullet notes explaining what was actually said under it — the argument, the examples used, how it was developed — enough that someone who missed the sermon understands the point. Never one-word or one-line points.
- "bible_references" MUST list EVERY scripture the preacher reads or cites — this is the most important field, never omit any. Give them as standard ENGLISH book names, normalizing Danish names: 1./2./3./4./5. Mosebog = Genesis/Exodus/Leviticus/Numbers/Deuteronomy, Salmerne = Psalms, Ordsprogene = Proverbs, Åbenbaringen = Revelation, Prædikeren = Ecclesiastes, etc. If a reference is garbled in the transcript, use the surrounding context to give the correct book+chapter, or omit it rather than guessing wrong.
- "key_quotes" are a few complete, memorable sentences, verbatim.

Respond with ONLY a JSON object, no other text:
{
  "title": "short descriptive sermon title",
  "summary": "2-4 sentence overview of the whole sermon",
  "sections": [{"heading": "the point", "notes": ["detailed note about what was said", "another detail"]}],
  "bible_references": ["John 3:16", "1 Corinthians 13:4-7"],
  "action_points": ["practical application the preacher called for", "..."],
  "key_quotes": ["a complete memorable sentence, verbatim", "..."],
  "tags": ["lowercase", "topic", "tags"]
}
Use empty arrays when a field genuinely has nothing.${BILINGUAL}`;

const ENRICH_SYSTEM_GENERAL = `You are a careful note-taker turning a video/talk transcript into DETAILED study notes for a personal knowledge base. Capture what was actually said — never invent content.

Produce thorough NOTES, not a thin summary:
- "sections" are the main points of the talk, in order. For each, a short heading AND 2-5 bullet notes explaining what was actually said under it — the argument, examples, how it developed — enough that someone who missed it understands. Never one-liners.
- "key_quotes" are a few complete, memorable sentences, verbatim.

Respond with ONLY a JSON object, no other text:
{
  "title": "short descriptive title",
  "summary": "2-4 sentence overview of the talk",
  "sections": [{"heading": "the point", "notes": ["detailed note", "another detail"]}],
  "bible_references": [],
  "action_points": ["concrete takeaway or thing to do", "..."],
  "key_quotes": ["a complete memorable sentence, verbatim", "..."],
  "tags": ["lowercase", "topic", "tags"]
}
Use empty arrays when a field genuinely has nothing. Leave bible_references empty unless the speaker actually cites scripture.${BILINGUAL}`;

const CONDENSE_SYSTEM = `You condense one part of a long transcript into DENSE study notes (no JSON).
Preserve in detail: each point and HOW it was argued (examples, reasoning), EVERY
scripture reference / citation mentioned (never drop these — they are critical),
concrete takeaways/action points, and short verbatim key quotes. Do not shorten
into vague labels — keep the substance so a later pass can write full notes.
If you see a sentence immediately repeated as its near-translation in another
language (live interpretation), collapse that PAIR to one point and quote the
FIRST sentence of the pair (the original speaker; the second is the interpreter).
Only matched pairs — do not treat an intro or any unpaired sentence as a
translation, and do not duplicate translations.`;

/**
 * Enrichment presets by job.style. The transcription pipeline is content-agnostic;
 * only this step (prompt + target folder + filename) is style-specific.
 */
interface StylePreset {
  system: string;
  folder: string;
  filename: (date: string, title: string, speaker: string) => string;
}
const STYLE_PRESETS: Record<string, StylePreset> = {
  sermon: {
    system: ENRICH_SYSTEM,
    folder: 'faith/sermons',
    filename: (date, title, speaker) => `${date} ${title} - ${speaker}`,
  },
  general: {
    system: ENRICH_SYSTEM_GENERAL,
    folder: 'articles',
    filename: (date, title) => `${date} ${title}`,
  },
};
const presetFor = (style: string): StylePreset => STYLE_PRESETS[style] ?? STYLE_PRESETS.sermon;

// Single LLM input budget (chars ≈ tokens*4). Longer transcripts get a per-piece
// condense pass first; the enrichment prompt then runs over the joined notes.
// Kept well under num_ctx (8192) so the final pass has room for DETAILED output.
const DEFAULT_INPUT_MAX_CHARS = 10_000;

// Enrichment is a BACKGROUND job — quality over speed: medium reasoning (voice
// uses low) for detailed notes that don't drop scripture refs. num_ctx MATCHES
// LLM_NUM_CTX (8192) on purpose — a different size would force a gpt-oss reload
// that thrashes with voice/watchdog. num_predict raised for longer notes.
const ENRICH_THINK: ThinkLevel = process.env.ENRICH_THINK ?? 'medium';
const ENRICH_GEN: GenOptions = {
  numCtx: Number(process.env.ENRICH_NUM_CTX ?? 8192),
  numPredict: Number(process.env.ENRICH_NUM_PREDICT ?? 4800),
};

/**
 * Sermon enrichment (issue #8): once the python worker marks a job `done`, turn
 * the transcript into a vault article — summary, themes, Bible refs, action
 * points, key quotes — via KnowledgeService.ingest (file + commit + row +
 * embedding). Trigger = interval poller over `done` jobs without an article
 * (claim is an atomic status flip, so a manual trigger never races it);
 * failures land in `enrich_error` + message and stay retryable.
 */
@Injectable()
export class EnrichmentService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(EnrichmentService.name);
  private timer?: NodeJS.Timeout;
  private readonly inputMaxChars = Number(
    process.env.ENRICH_INPUT_MAX_CHARS ?? DEFAULT_INPUT_MAX_CHARS,
  );

  constructor(
    @Inject(SERMON_REPO) private readonly repo: SermonRepo,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly knowledge: KnowledgeService,
    /** Poll interval in ms; 0 disables the poller (tests). */
    @Inject(ENRICH_POLL_MS) private readonly pollMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.pollMs <= 0) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((e) => this.log.error(`poll failed: ${message(e)}`));
    }, this.pollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Drain the queue: enrich every `done` job without an article. */
  async pollOnce(): Promise<number> {
    let enriched = 0;
    for (;;) {
      const job = await this.repo.claimForEnrichment();
      if (!job) return enriched;
      try {
        const res = await this.enrichClaimed(job);
        this.log.log(`job ${job.id}: article ${res.path}`);
        enriched++;
      } catch (e) {
        // enrichClaimed already recorded enrich_error; keep draining
        this.log.error(`job ${job.id}: enrichment failed: ${message(e)}`);
      }
    }
  }

  /** Manual (re)trigger: POST /api/sermons/:id/enrich. */
  async enrich(id: string): Promise<EnrichResult> {
    const job = await this.repo.getById(id);
    if (!job) throw new NotFoundException(`no sermon job ${id}`);
    if (job.articleItemId) {
      throw new ConflictException({
        message: 'sermon already enriched',
        itemId: job.articleItemId,
        path: job.articlePath,
      });
    }
    const claimed = await this.repo.startEnrichment(id);
    if (!claimed) {
      throw new ConflictException(
        `job ${id} not enrichable (status ${job.status}) — needs a finished transcript`,
      );
    }
    return this.enrichClaimed(claimed);
  }

  /** Job already flipped to `enriching`; success → enriched, failure → enrich_error. */
  private async enrichClaimed(job: SermonJob): Promise<EnrichResult> {
    try {
      if (!job.transcript?.trim()) throw new Error('job has no transcript');
      const preset = presetFor(job.style);
      const enrichment = await this.generate(job.transcript, preset.system);

      const title = job.title?.trim() || enrichment.title;
      const date = job.sermonDate ?? new Date().toISOString().slice(0, 10);
      const speaker = job.speaker?.trim() || 'Unknown';
      const tags = dedupe([
        ...enrichment.tags.map((t) => t.toLowerCase()),
        ...refsToTags(enrichment.bibleReferences),
      ]);

      const item = await this.knowledge.ingest({
        title,
        markdown: buildArticleBody(enrichment, job.id, job.sourceUrl ?? undefined),
        source: `sermon:${job.id}`,
        tags,
        summary: enrichment.summary,
        folder: preset.folder,
        filename: preset.filename(date, title, speaker),
        created: date,
      });
      await this.repo.completeEnrichment(job.id, item.id, item.path);
      return { itemId: item.id, path: item.path, title };
    } catch (e) {
      await this.repo.failEnrichment(job.id, message(e));
      throw e;
    }
  }

  /** Full transcript when it fits; condense pieces first when it does not. */
  private async generate(transcript: string, system: string): Promise<Enrichment> {
    const input =
      transcript.length <= this.inputMaxChars
        ? transcript
        : await this.condense(transcript);
    const raw = stripThink(
      toReply(
        await this.llm.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: `Transcript:\n\n${input}` },
          ],
          undefined,
          undefined,
          ENRICH_THINK,
          ENRICH_GEN,
        ),
      ).content,
    );
    return parseEnrichment(raw);
  }

  private async condense(transcript: string): Promise<string> {
    const pieces = splitByLength(transcript, this.inputMaxChars);
    const notes: string[] = [];
    for (const [i, piece] of pieces.entries()) {
      const raw = stripThink(
        toReply(
          await this.llm.chat(
            [
              { role: 'system', content: CONDENSE_SYSTEM },
              {
                role: 'user',
                content: `Transcript part ${i + 1}/${pieces.length}:\n\n${piece}`,
              },
            ],
            undefined,
            undefined,
            ENRICH_THINK,
            ENRICH_GEN,
          ),
        ).content,
      );
      notes.push(raw);
    }
    // One pass is enough in practice; guard against a chatty model anyway.
    return notes.join('\n\n').slice(0, this.inputMaxChars);
  }
}

/** Markdown article body per PRD: all generated fields + pointer to the job. */
export function buildArticleBody(e: Enrichment, jobId: string, sourceUrl?: string): string {
  const bullets = (items: string[]) => items.map((s) => `- ${s}`).join('\n');
  const sections = [`## Summary\n\n${e.summary}`];
  if (sourceUrl) sections.push(`## Source\n\n[Original video](${sourceUrl})`);
  if (e.sections.length) {
    const notes = e.sections
      .map((s) => `### ${s.heading}\n\n${bullets(s.notes)}`)
      .join('\n\n');
    sections.push(`## Notes\n\n${notes}`);
  }
  if (e.bibleReferences.length) {
    sections.push(`## Bible References\n\n${bullets(e.bibleReferences)}`);
  }
  if (e.actionPoints.length) {
    sections.push(`## Action Points\n\n${bullets(e.actionPoints)}`);
  }
  if (e.keyQuotes.length) {
    sections.push(
      `## Key Quotes\n\n${e.keyQuotes.map((q) => `> ${q}`).join('\n\n')}`,
    );
  }
  sections.push(
    `## Transcript\n\nFull transcript on sermon job \`${jobId}\` — \`GET /api/sermons/${jobId}\`.`,
  );
  return sections.join('\n\n');
}

/** Lenient parse of the enrichment answer: tolerate fences/prose, both casings. */
export function parseEnrichment(raw: string): Enrichment {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw badEnrichment(raw);
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw badEnrichment(raw);
  }
  const d = data as Record<string, unknown>;
  const title = typeof d.title === 'string' ? d.title.trim() : '';
  const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
  if (!title || !summary) throw badEnrichment(raw);
  return {
    title,
    summary,
    sections: parseSections(d.sections),
    bibleReferences: strings(d.bible_references ?? d.bibleReferences),
    actionPoints: strings(d.action_points ?? d.actionPoints),
    keyQuotes: strings(d.key_quotes ?? d.keyQuotes),
    tags: strings(d.tags),
  };
}

/** Parse "sections": [{heading, notes[]}] — tolerant of a missing/loose shape. */
function parseSections(value: unknown): { heading: string; notes: string[] }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const heading = typeof o.heading === 'string' ? o.heading.trim() : '';
      const notes = strings(o.notes);
      return { heading, notes };
    })
    .filter((s) => s.heading || s.notes.length);
}

/**
 * Bible reference → structured tag: book + chapter, verses dropped.
 * "John 3:16" → ref:john-3, "1 Corinthians 13:4-7" → ref:1-corinthians-13,
 * bookless/garbage input → null.
 */
export function refToTag(ref: string): string | null {
  const cleaned = ref.split(':')[0].trim(); // strip verse part
  if (!cleaned) return null;
  const m = cleaned.match(/^(.+?)\s+(\d+)$/); // trailing chapter number
  const book = m ? m[1] : cleaned;
  const chapter = m ? m[2] : null;
  if (!/[a-z]/i.test(book)) return null;
  const slug = slugify(book);
  return chapter ? `ref:${slug}-${chapter}` : `ref:${slug}`;
}

export function refsToTags(refs: string[]): string[] {
  return dedupe(refs.map(refToTag).filter((t): t is string => t !== null));
}

/** Split on whitespace near maxLen so no LLM call exceeds the input budget. */
export function splitByLength(text: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > maxLen / 2 ? cut : maxLen;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function badEnrichment(raw: string): Error {
  return new Error(`LLM enrichment output not usable JSON: ${raw.slice(0, 200)}`);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
