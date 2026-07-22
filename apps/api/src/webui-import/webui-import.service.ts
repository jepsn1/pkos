import { Inject, Injectable } from '@nestjs/common';
import { AttachmentsService, attachmentUrl } from '../attachments/attachments.service';

/**
 * THE Open WebUI coupling point — the one module that drifts if webui changes.
 * When webui sends a chat request with an attached file it (a) injects the
 * extracted text and (b) lists the raw file in an <attached_files> block with the
 * webui file id. This service parses that block, pulls the ORIGINAL bytes from
 * webui's file API, and copies them into our own attachment store — so the note
 * can reference a portable pkos URL instead of webui's ephemeral file:// handle.
 * webui is never modified; we only call its REST API (read-only) with a token.
 */
export const WEBUI_IMPORT_FETCH = 'WEBUI_IMPORT_FETCH';

const IMPORT_TIMEOUT_MS = Number(process.env.WEBUI_IMPORT_TIMEOUT_MS ?? 30000);

export interface ImportedFile {
  name: string;
  url: string;
  mime: string;
}

interface WebuiFileRef {
  id: string;
  name: string;
  mime: string;
}

@Injectable()
export class WebuiImportService {
  constructor(
    @Inject(WEBUI_IMPORT_FETCH) private readonly fetchFn: typeof fetch,
    private readonly attachments: AttachmentsService,
  ) {}

  /** Configured = we have both a webui base URL and an API token. */
  get enabled(): boolean {
    return Boolean(process.env.WEBUI_API_KEY);
  }

  /**
   * Import any files referenced in a webui message into our store. Best-effort:
   * a file that fails to fetch is skipped (logged), never breaks the turn.
   * Dedupe is handled downstream (AttachmentsService keys on sha256).
   */
  async importFromMessage(content: string): Promise<ImportedFile[]> {
    if (!this.enabled) return [];
    const refs = parseAttachedFiles(content);
    const out: ImportedFile[] = [];
    for (const ref of refs) {
      try {
        const buffer = await this.fetchFile(ref.id);
        const a = await this.attachments.store(
          { buffer, originalname: ref.name, mimetype: ref.mime },
          undefined,
        );
        out.push({ name: a.filename, url: attachmentUrl(a.id), mime: a.mime });
      } catch (err) {
        console.warn(`[webui-import] skip ${ref.name} (${ref.id}): ${(err as Error).message}`);
      }
    }
    return out;
  }

  private async fetchFile(id: string): Promise<Buffer> {
    const base = process.env.WEBUI_URL ?? 'http://pkos-webui:8080';
    const res = await this.fetchFn(`${base}/api/v1/files/${id}/content`, {
      headers: { Authorization: `Bearer ${process.env.WEBUI_API_KEY}` },
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`webui file API HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Pull {id,name,mime} out of webui's <attached_files><file .../></attached_files>. */
export function parseAttachedFiles(content: string): WebuiFileRef[] {
  const block = content.match(/<attached_files>([\s\S]*?)<\/attached_files>/);
  if (!block) return [];
  const refs: WebuiFileRef[] = [];
  const tags = block[1].match(/<file\b[^>]*>/g) ?? [];
  for (const tag of tags) {
    const id = attr(tag, 'url');
    if (!id) continue;
    refs.push({
      id,
      name: attr(tag, 'name') ?? id,
      mime: attr(tag, 'content_type') ?? 'application/octet-stream',
    });
  }
  return refs;
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}
