import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { BibleService } from './bible.service';
import { formatReference, parseReference } from './reference';

export const BIBLE_ROUTING = `You also have a get_verse tool for exact Bible text (authorized Danish translation):
- get_verse (SCRIPTURE): whenever a note or answer needs to QUOTE the Bible, call get_verse with the reference (e.g. "Matt 7:21-23", "Romerne 10:9-13", "Sl 23") to fetch the exact verbatim text. NEVER quote scripture from memory or paraphrase it as if it were a quotation — quote only what get_verse returns, keep it in the returned (Danish) wording, and cite the reference. If get_verse returns an error or nothing, say the exact wording could not be verified rather than inventing a quote.`;

const BIBLE_TOOLS: LlmTool[] = [
  {
    name: 'get_verse',
    description:
      'Fetch the exact, verbatim text of a Bible passage (authorized Danish translation) by reference. Use this whenever you need to quote scripture, instead of quoting from memory. Accepts Danish or English book names and abbreviations, e.g. "Matt 7:21-23", "Romerne 10:9-13", "John 3:16", "Sl 23". Returns the verses with numbers and the translation.',
    parameters: {
      type: 'object',
      required: ['reference'],
      properties: {
        reference: {
          type: 'string',
          description: 'A passage reference, e.g. "Matt 7:21-23" or "Romerne 10:9-13".',
        },
      },
    },
  },
];

class ToolArgError extends Error {}

/** LLM tool surface over BibleService — verbatim scripture lookup for quoting. */
@Injectable()
export class BibleToolsService {
  readonly tools = BIBLE_TOOLS;

  constructor(private readonly bible: BibleService) {}

  routingPrompt(): string {
    return BIBLE_ROUTING;
  }

  async execute(call: LlmToolCall): Promise<string> {
    try {
      if (call.name !== 'get_verse') {
        return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const raw = args.reference;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new ToolArgError('reference must be a non-empty string');
      }
      const ref = parseReference(raw);
      if (!ref) {
        return JSON.stringify({ error: `could not parse reference "${raw}"` });
      }
      const verses = await this.bible.getVerses(ref);
      if (verses.length === 0) {
        return JSON.stringify({
          error: `no text found for "${formatReference(ref)}"`,
          reference: formatReference(ref),
        });
      }
      return JSON.stringify({
        reference: formatReference(ref),
        translation: this.bible.translation,
        verses,
        text: verses.map((v) => `${v.verse} ${v.text}`).join('\n'),
      });
    } catch (err) {
      if (err instanceof ToolArgError) return JSON.stringify({ error: err.message });
      return JSON.stringify({ error: `get_verse failed: ${(err as Error).message}` });
    }
  }
}
