import { beforeEach, describe, expect, it } from 'vitest';
import { FitnessToolsService } from '../fitness/fitness-tools.service';
import type {
  BodyMetricRow,
  FitnessRepo,
  NewBodyMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from '../fitness/fitness.repo';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type { KnowledgeRepo, SearchHit } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import type { ChatRepo, Conversation, Message, NewMessage } from './chat.repo';
import { ChatService } from './chat.service';
import type { LlmMessage, LlmProvider, LlmReply, LlmTool } from './llm.provider';

/** Records messages AND tools per call; replies from a scripted queue. */
class FakeToolLlm implements LlmProvider {
  calls: Array<{ messages: LlmMessage[]; tools?: LlmTool[] }> = [];
  queue: Array<string | LlmReply> = [];

  async chat(messages: LlmMessage[], tools?: LlmTool[]): Promise<string | LlmReply> {
    // snapshot: ChatService mutates the same array across rounds
    this.calls.push({ messages: [...messages], tools });
    return this.queue.shift() ?? { content: 'done', toolCalls: [] };
  }
}

class FakeChatRepo implements ChatRepo {
  conversations: Conversation[] = [];
  messages: Message[] = [];
  private seq = 0;

  async createConversation(title: string): Promise<Conversation> {
    const now = new Date();
    const conv = { id: `conv-${++this.seq}`, title, created: now, updated: now };
    this.conversations.push(conv);
    return conv;
  }
  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find((c) => c.id === id) ?? null;
  }
  async listConversations(): Promise<Conversation[]> {
    return this.conversations;
  }
  async touchConversation(): Promise<void> {}
  async addMessage(msg: NewMessage): Promise<Message> {
    const row = { ...msg, id: `msg-${++this.seq}`, created: new Date() };
    this.messages.push(row);
    return row;
  }
  async listMessages(conversationId: string): Promise<Message[]> {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }
}

const rejectUnused = () => Promise.reject(new Error('unused'));

class FakeFitnessRepo implements FitnessRepo {
  workouts: WorkoutWithSets[] = [];
  metrics: BodyMetricRow[] = [];
  private seq = 0;

  async createWorkout(
    date: string,
    notes: string | null,
    exercises: NewWorkoutExercise[],
  ): Promise<WorkoutWithSets> {
    const id = `w-${++this.seq}`;
    const sets = exercises.flatMap((ex) =>
      ex.sets.map((s, i) => ({
        id: `s-${++this.seq}`,
        workoutId: id,
        exercise: ex.exercise,
        setNo: i + 1,
        reps: s.reps,
        weightKg: s.weightKg,
      })),
    );
    const w = { id, date, notes, sets };
    this.workouts.push(w);
    return w;
  }
  async insertBodyMetric(m: NewBodyMetric): Promise<BodyMetricRow> {
    const row = { id: `m-${++this.seq}`, ...m };
    this.metrics.push(row);
    return row;
  }
  async metricsBetween(since: string, until: string): Promise<BodyMetricRow[]> {
    return this.metrics.filter((m) => m.date >= since && m.date <= until);
  }
  setsForExercise = rejectUnused;
  setsSince = rejectUnused;
  recentWorkouts = rejectUnused;
  listMetrics = rejectUnused;
}

function knowledgeRepoWith(hits: SearchHit[]): KnowledgeRepo {
  return {
    search: async (_e: number[], limit: number) => hits.slice(0, limit),
    upsert: rejectUnused,
    list: rejectUnused,
    getById: rejectUnused,
    wipe: rejectUnused,
  };
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [1, 0, 0] };
const GRACE_HIT: SearchHit = {
  id: 'k1',
  path: 'faith/reflections/on-grace.md',
  title: 'On Grace',
  summary: 'Grace is unmerited favor.',
  score: 0.72,
};

let chatRepo: FakeChatRepo;
let fitnessRepo: FakeFitnessRepo;
let llm: FakeToolLlm;

beforeEach(() => {
  chatRepo = new FakeChatRepo();
  fitnessRepo = new FakeFitnessRepo();
  llm = new FakeToolLlm();
});

function makeService(hits: SearchHit[] = []): ChatService {
  const vault = new VaultService('/nonexistent-vault', async () => {});
  const fitness = new FitnessToolsService(fitnessRepo, () => new Date('2026-07-13T10:00:00Z'));
  return new ChatService(
    chatRepo,
    knowledgeRepoWith(hits),
    fakeEmbedder,
    llm,
    vault,
    fitness,
  );
}

describe('ChatService planner (fitness tools)', () => {
  it('offers fitness tools + routing prompt, executes tool_calls, feeds results back', async () => {
    const service = makeService();
    llm.queue.push(
      {
        content: '',
        toolCalls: [
          {
            name: 'log_workout',
            arguments: {
              exercises: [
                {
                  exercise: 'bench press',
                  sets: Array(5).fill({ reps: 5, weight_kg: 80 }),
                },
              ],
            },
          },
        ],
      },
      'Logged bench press 5x5 at 80kg.',
    );

    const res = await service.chat('log bench press 5x5 at 80kg today');

    // routing: tools offered on the first call, routing text in the system prompt
    expect(llm.calls[0].tools?.map((t) => t.name)).toEqual([
      'log_workout',
      'log_body_metric',
      'query_fitness',
    ]);
    expect(llm.calls[0].messages[0].content).toContain('log_workout');

    // the tool actually ran
    expect(fitnessRepo.workouts).toHaveLength(1);
    expect(fitnessRepo.workouts[0].sets).toHaveLength(5);
    expect(fitnessRepo.workouts[0].date).toBe('2026-07-13');

    // second LLM call carries the assistant tool_calls turn + the tool result
    const second = llm.calls[1].messages;
    const assistantTurn = second.at(-2)!;
    const toolTurn = second.at(-1)!;
    expect(assistantTurn.toolCalls?.[0].name).toBe('log_workout');
    expect(toolTurn.role).toBe('tool');
    expect(toolTurn.toolName).toBe('log_workout');
    expect(JSON.parse(toolTurn.content)).toMatchObject({ logged: true, total_sets: 5 });

    expect(res.answer).toBe('Logged bench press 5x5 at 80kg.');
    // only user + final assistant messages persisted, tool plumbing stays internal
    expect(chatRepo.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chatRepo.messages[1].content).toBe(res.answer);
  });

  it('runs multi-round tool loops (call → result → another call → answer)', async () => {
    const service = makeService();
    llm.queue.push(
      {
        content: '',
        toolCalls: [
          { name: 'log_body_metric', arguments: { weight_kg: 82.4, protein_g: 160 } },
        ],
      },
      {
        content: '',
        toolCalls: [
          { name: 'query_fitness', arguments: { query: 'metric_avg', metric: 'protein_g' } },
        ],
      },
      'Logged. Your 7-day protein average is 160g.',
    );

    const res = await service.chat('log weight 82.4 and 160g protein, how am I trending?');

    expect(llm.calls).toHaveLength(3);
    expect(fitnessRepo.metrics).toHaveLength(1);
    const avgResult = JSON.parse(llm.calls[2].messages.at(-1)!.content);
    expect(avgResult).toMatchObject({ metric: 'protein_g', count: 1, avg: 160 });
    expect(res.answer).toBe('Logged. Your 7-day protein average is 160g.');
  });

  it('feeds bad tool args back as {error} so the model can recover', async () => {
    const service = makeService();
    llm.queue.push(
      { content: '', toolCalls: [{ name: 'log_body_metric', arguments: {} }] },
      'I need at least one metric — weight, calories or protein.',
    );

    const res = await service.chat('log my metrics');

    expect(fitnessRepo.metrics).toHaveLength(0);
    const toolTurn = llm.calls[1].messages.at(-1)!;
    expect(JSON.parse(toolTurn.content).error).toMatch(/at least one/);
    expect(res.answer).toBe('I need at least one metric — weight, calories or protein.');
  });

  it('stops a tool-call-forever model after the round cap', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      llm.queue.push({
        content: '',
        toolCalls: [{ name: 'query_fitness', arguments: { query: 'metric_avg', metric: 'calories' } }],
      });
    }

    await service.chat('average calories?');
    expect(llm.calls.length).toBe(5); // initial + MAX_TOOL_ROUNDS
  });

  it('knowledge questions keep the vector path: no tool round, citations intact', async () => {
    const service = makeService([GRACE_HIT]);
    llm.queue.push({
      content: 'Grace is unmerited favor (faith/reflections/on-grace.md).',
      toolCalls: [],
    });

    const res = await service.chat('what have I collected about grace?');

    expect(llm.calls).toHaveLength(1);
    expect(fitnessRepo.workouts).toHaveLength(0);
    expect(res.answer).toBe('Grace is unmerited favor (faith/reflections/on-grace.md).');
    expect(res.citations).toEqual([
      { path: 'faith/reflections/on-grace.md', title: 'On Grace', score: 0.72 },
    ]);
    // knowledge items still grounded in the system prompt alongside routing rules
    const system = llm.calls[0].messages[0].content;
    expect(system).toContain('ONLY');
    expect(system).toContain('faith/reflections/on-grace.md');
    expect(system).toContain('do NOT call fitness tools');
  });
});
