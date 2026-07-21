import { Inject, Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';

/** Injected so tests can supply a fake SearXNG. */
export const WEB_SEARCH_FETCH = 'WEB_SEARCH_FETCH';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 15000);

export const WEB_SEARCH_ROUTING = `You also have a web_search tool for the open internet:
- web_search (EXTERNAL): call it when the answer needs current or external facts NOT in the user's vault — news, dates, prices, the actual contents of a public book/article, anything that may have changed or that you are unsure of. It returns ranked results {title, url, snippet}; answer from them and cite the source URL(s).
Prefer the vault (retrieval, read_note, list_notes) for anything personal or already saved. Only reach for web_search when the user clearly wants outside/current information, or the vault has nothing and answering from memory would be a guess.`;

const WEB_SEARCH_TOOLS: LlmTool[] = [
  {
    name: 'web_search',
    description:
      'Search the open web (self-hosted SearXNG) for current or external information not in the vault. Returns ranked results with title, url and snippet.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: {
          type: 'number',
          description: `Max results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        },
      },
    },
  },
];

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}
interface SearxResponse {
  results?: SearxResult[];
}

class ToolArgError extends Error {}

/**
 * Web search over a self-hosted SearXNG instance (JSON API). Standalone ToolSet:
 * the model calls it when a question needs external/current info. Queries leave
 * the box via SearXNG to public engines — result content is from the internet.
 */
@Injectable()
export class WebSearchToolService {
  constructor(@Inject(WEB_SEARCH_FETCH) private readonly fetchFn: typeof fetch) {}

  readonly tools = WEB_SEARCH_TOOLS;

  routingPrompt(): string {
    return WEB_SEARCH_ROUTING;
  }

  /** Run one tool call; result (or {error}) JSON-serialized for the tool message. */
  async execute(call: LlmToolCall): Promise<string> {
    try {
      if (call.name !== 'web_search') {
        return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
      return JSON.stringify(await this.search((call.arguments ?? {}) as Record<string, unknown>));
    } catch (err) {
      const message =
        err instanceof ToolArgError
          ? err.message
          : `web_search failed: ${(err as Error).message}`;
      return JSON.stringify({ error: message });
    }
  }

  private async search(args: Record<string, unknown>) {
    const query = requiredString(args.query, 'query');
    const limit = clampLimit(args.limit);
    const base = process.env.SEARXNG_URL ?? 'http://pkos-searxng:8080';
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await this.fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const data = (await res.json()) as SearxResponse;
    const results = (data.results ?? [])
      .filter((r): r is Required<Pick<SearxResult, 'title' | 'url'>> & SearxResult =>
        Boolean(r.title && r.url),
      )
      .slice(0, limit)
      .map((r) => ({ title: r.title.trim(), url: r.url, snippet: (r.content ?? '').trim() }));
    return { query, count: results.length, results };
  }
}

function requiredString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolArgError(`${field} must be a non-empty string`);
  }
  return v.trim();
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : DEFAULT_LIMIT;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}
