import { beforeEach, describe, expect, it } from 'vitest';
import { FitnessToolsService } from '../fitness/fitness-tools.service';
import type {
  FitnessRepo,
  MetricRow,
  NewMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from '../fitness/fitness.repo';
import type { GraphRetrieval } from '../graph/graph.retrieval';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type { KnowledgeRepo, SearchHit } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import type { ChatRepo } from './chat.repo';
import { ChatService } from './chat.service';
import type { LlmMessage, LlmProvider, LlmReply, LlmTool } from './llm.provider';

/** Scripted streaming fake: each round pushes its tokens then resolves its reply. */
class FakeStreamLlm implements LlmProvider {
  rounds: Array<{ tokens: string[]; reply: LlmReply }> = [];
  chatCalls = 0;
  streamCalls = 0;

  async chat(_messages: LlmMessage[], _tools?: LlmTool[]): Promise<string | LlmReply> {
    this.chatCalls++;
    const r = this.rounds.shift();
    if (!r) return { content: 'canned', toolCalls: [] };
    return r.reply;
  }

  async chatStream(
    _messages: LlmMessage[],
    _tools: LlmTool[] | undefined,
    onToken: (token: string) => void,
  ): Promise<LlmReply> {
    this.streamCalls++;
    const r = this.rounds.shift();
    if (!r) return { content: 'canned', toolCalls: [] };
    for (const t of r.tokens) onToken(t);
    return r.reply;
  }
}

/** chat()-only fake without chatStream (legacy provider shape). */
class NonStreamLlm implements LlmProvider {
  async chat(): Promise<string | LlmReply> {
    return { content: '<think>hm</think> full answer ', toolCalls: [] };
  }
}

const rejectUnused = () => Promise.reject(new Error('unused'));

class FakeFitnessRepo implements FitnessRepo {
  metrics: MetricRow[] = [];
  private seq = 0;

  async insertMetric(m: NewMetric): Promise<MetricRow> {
    const row = { id: `m-${++this.seq}`, ...m };
    this.metrics.push(row);
    return row;
  }
  createWorkout(
    _date: string,
    _notes: string | null,
    _exercises: NewWorkoutExercise[],
  ): Promise<WorkoutWithSets> {
    return rejectUnused();
  }
  latestMetric = rejectUnused;
  latestMetrics = rejectUnused;
  metricsBetween = rejectUnused;
  metricNames = rejectUnused;
  listMetrics = rejectUnused;
  setsForExercise = rejectUnused;
  setsSince = rejectUnused;
  recentWorkouts = rejectUnused;
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [1, 0, 0] };
const noGraph: GraphRetrieval = { neighbors: async () => [] };
const unusedRepo = {} as ChatRepo;

function knowledgeRepoWith(hits: SearchHit[]): KnowledgeRepo {
  return {
    search: async (_e: number[], limit: number) => hits.slice(0, limit),
    upsert: rejectUnused,
    list: rejectUnused,
    getById: rejectUnused,
    move: rejectUnused,
    wipe: rejectUnused,
  };
}

const GRACE_HIT: SearchHit = {
  id: 'k1',
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  summary: 'Grace is unmerited favor.',
  score: 0.72,
};

let llm: FakeStreamLlm;
let fitnessRepo: FakeFitnessRepo;

beforeEach(() => {
  llm = new FakeStreamLlm();
  fitnessRepo = new FakeFitnessRepo();
});

function makeService(provider: LlmProvider, hits: SearchHit[] = [], withFitness = false) {
  const vault = new VaultService('/nonexistent-vault', async () => {});
  const fitness = withFitness
    ? new FitnessToolsService(fitnessRepo, () => new Date('2026-07-14T10:00:00Z'))
    : undefined;
  return new ChatService(
    unusedRepo,
    knowledgeRepoWith(hits),
    fakeEmbedder,
    provider,
    vault,
    noGraph,
    fitness,
  );
}

describe('ChatService.answer streaming', () => {
  it('emits tokens as they arrive; answer === concatenation of emitted tokens', async () => {
    llm.rounds.push({
      tokens: ['Grace', ' is', ' unmerited', ' favor.'],
      reply: { content: 'Grace is unmerited favor.', toolCalls: [] },
    });
    const service = makeService(llm, [GRACE_HIT]);

    const emitted: string[] = [];
    const res = await service.answer('grace?', [], (t) => emitted.push(t));

    expect(llm.streamCalls).toBe(1);
    expect(llm.chatCalls).toBe(0);
    expect(emitted).toEqual(['Grace', ' is', ' unmerited', ' favor.']);
    expect(res.answer).toBe(emitted.join(''));
    expect(res.citations).toEqual([
      { path: 'faith/reflections/on-grace.md', title: 'On Grace', score: 0.72 },
    ]);
  });

  it('suppresses <think> blocks on the fly (split across tokens)', async () => {
    llm.rounds.push({
      tokens: ['<thi', 'nk>secret', ' plan</think>', 'Real', ' answer'],
      reply: { content: 'Real answer', toolCalls: [] },
    });
    const service = makeService(llm);

    const emitted: string[] = [];
    const res = await service.answer('hi', [], (t) => emitted.push(t));

    expect(emitted.join('')).toBe('Real answer');
    expect(emitted.join('')).not.toContain('secret');
    expect(res.answer).toBe('Real answer');
  });

  it('tool rounds stay silent; only the post-tool final round streams', async () => {
    llm.rounds.push(
      {
        tokens: [], // provider keeps tool rounds silent
        reply: {
          content: '',
          toolCalls: [{ name: 'log_metric', arguments: { name: 'weight_kg', value: 82.5 } }],
        },
      },
      {
        tokens: ['Logged', ' 82.5kg.'],
        reply: { content: 'Logged 82.5kg.', toolCalls: [] },
      },
    );
    const service = makeService(llm, [], true);

    const emitted: string[] = [];
    const res = await service.answer('log weight 82.5', [], (t) => emitted.push(t));

    expect(llm.streamCalls).toBe(2); // tool round + final round, both streamed
    expect(fitnessRepo.metrics).toHaveLength(1); // the tool actually ran
    expect(emitted).toEqual(['Logged', ' 82.5kg.']);
    expect(res.answer).toBe('Logged 82.5kg.');
  });

  it('without onToken: chatStream is never used, behavior unchanged', async () => {
    llm.rounds.push({ tokens: [], reply: { content: 'plain', toolCalls: [] } });
    const service = makeService(llm, [GRACE_HIT]);

    const res = await service.answer('grace?');

    expect(llm.streamCalls).toBe(0);
    expect(llm.chatCalls).toBe(1);
    expect(res.answer).toBe('plain');
  });

  it('provider without chatStream degrades to one whole-answer emission', async () => {
    const service = makeService(new NonStreamLlm());

    const emitted: string[] = [];
    const res = await service.answer('hi', [], (t) => emitted.push(t));

    expect(emitted).toEqual(['full answer']); // think-stripped, single token
    expect(res.answer).toBe('full answer');
  });
});
