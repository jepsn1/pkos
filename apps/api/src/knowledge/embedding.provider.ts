import { Inject, Injectable } from '@nestjs/common';

export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';
export const EMBED_FETCH = 'EMBED_FETCH';

/** Turns text into a vector. Real impl calls ollama; tests inject a fake. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

// Generous: embeds are ms of compute, but can queue behind an in-flight qwen
// generation when ollama juggles model loading on the shared GPU.
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 120_000);

@Injectable()
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(@Inject(EMBED_FETCH) private readonly fetchFn: typeof fetch) {}

  async embed(text: string): Promise<number[]> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
    // num_gpu:0 keeps this tiny model on CPU (~100ms) so it never competes with
    // the chat model for VRAM. On a 16GB card gpt-oss+nomic don't co-fit during
    // active inference, so sharing the GPU forced a full model reload every turn
    // (multi-second stall). CPU embeds → gpt-oss stays resident, no swap.
    // EMBED_NUM_GPU=-1 lets a bigger card keep it on GPU.
    const numGpu = Number(process.env.EMBED_NUM_GPU ?? 0);
    const res = await this.fetchFn(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text, options: { num_gpu: numGpu } }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama embed failed: HTTP ${res.status}`);
    const data = (await res.json()) as { embeddings?: number[][] };
    const embedding = data.embeddings?.[0];
    if (!embedding?.length) throw new Error('ollama embed returned no embedding');
    return embedding;
  }
}
