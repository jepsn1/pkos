import { beforeEach, describe, expect, it } from 'vitest';
import { FitnessToolsService } from '../fitness/fitness-tools.service';
import type {
  FitnessRepo,
  MetricNameRow,
  MetricRow,
  NewMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from '../fitness/fitness.repo';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import { KnowledgeToolsService } from '../knowledge/knowledge-tools.service';
import type { KnowledgeItem, KnowledgeRepo, SearchHit } from '../knowledge/knowledge.repo';
import type { IngestRequest, KnowledgeService } from '../knowledge/knowledge.service';
import { VaultService } from '../knowledge/vault.service';
import type { GraphRetrieval } from '../graph/graph.retrieval';
import type {
  ChatRepo,
  Conversation,
  ConversationListItem,
  Message,
  NewMessage,
} from './chat.repo';
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
    const conv = {
      id: `conv-${++this.seq}`,
      title,
      created: now,
      updated: now,
      savedItemId: null,
    };
    this.conversations.push(conv);
    return conv;
  }
  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find((c) => c.id === id) ?? null;
  }
  async listConversations(): Promise<ConversationListItem[]> {
    return this.conversations.map((c) => ({ ...c, savedPath: null }));
  }
  async setSavedItem(conversationId: string, itemId: string): Promise<void> {
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (conv) conv.savedItemId = itemId;
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
  metrics: MetricRow[] = [];
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
  async insertMetric(m: NewMetric): Promise<MetricRow> {
    const row = { id: `m-${++this.seq}`, ...m };
    this.metrics.push(row);
    return row;
  }
  async latestMetric(name: string): Promise<MetricRow | null> {
    return (
      [...this.metrics]
        .filter((m) => m.name === name)
        .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
    );
  }
  async latestMetrics(): Promise<MetricRow[]> {
    const names = [...new Set(this.metrics.map((m) => m.name))].sort();
    const rows: MetricRow[] = [];
    for (const n of names) rows.push((await this.latestMetric(n))!);
    return rows;
  }
  async metricsBetween(
    name: string,
    since: string | null,
    until: string | null,
  ): Promise<MetricRow[]> {
    return this.metrics.filter(
      (m) =>
        m.name === name &&
        (since === null || m.date >= since) &&
        (until === null || m.date <= until),
    );
  }
  async metricNames(): Promise<MetricNameRow[]> {
    const byName = new Map<string, MetricRow[]>();
    for (const m of this.metrics) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => ({
        name,
        count: rows.length,
        lastDate: rows.map((r) => r.date).sort().at(-1)!,
      }));
  }
  listMetrics = rejectUnused;
  setsForExercise = rejectUnused;
  setsSince = rejectUnused;
  recentWorkouts = rejectUnused;
}

/** Records ingest calls; canned item echoing the request (for save_note). */
class FakeKnowledgeService {
  ingested: IngestRequest[] = [];

  async ingest(req: IngestRequest): Promise<KnowledgeItem> {
    this.ingested.push(req);
    return {
      id: 'item-1',
      path: `${req.folder ?? 'articles'}/esv-preference.md`,
      title: req.title,
      source: req.source ?? null,
      tags: req.tags ?? [],
      summary: req.summary ?? null,
      importance: null,
      created: '2026-07-13',
      updated: new Date(),
    };
  }
}

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
let knowledgeService: FakeKnowledgeService;
let llm: FakeToolLlm;

beforeEach(() => {
  chatRepo = new FakeChatRepo();
  fitnessRepo = new FakeFitnessRepo();
  knowledgeService = new FakeKnowledgeService();
  llm = new FakeToolLlm();
});

function makeService(hits: SearchHit[] = [], withKnowledgeTools = false): ChatService {
  const vault = new VaultService('/nonexistent-vault', async () => {});
  const fitness = new FitnessToolsService(fitnessRepo, () => new Date('2026-07-13T10:00:00Z'));
  const knowledgeTools = withKnowledgeTools
    ? new KnowledgeToolsService(knowledgeService as unknown as KnowledgeService)
    : undefined;
  const noGraph: GraphRetrieval = { neighbors: async () => [] };
  return new ChatService(
    chatRepo,
    knowledgeRepoWith(hits),
    fakeEmbedder,
    llm,
    vault,
    noGraph,
    fitness,
    knowledgeTools,
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
      'log_workout_text',
      'log_metric',
      'query_metric',
      'query_fitness',
    ]);
    expect(llm.calls[0].messages[0].content).toContain('log_workout');
    expect(llm.calls[0].messages[0].content).toContain("Today's date is 2026-07-13");
    // messy/long gym logs route to log_workout_text with the text passed verbatim
    expect(llm.calls[0].messages[0].content).toContain('log_workout_text');
    expect(llm.calls[0].messages[0].content).toContain('VERBATIM');

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

  it('logs a freeform metric ("my height is 180 cm" → log_metric height_cm)', async () => {
    const service = makeService();
    llm.queue.push(
      {
        content: '',
        toolCalls: [
          { name: 'log_metric', arguments: { name: 'Height (cm)', value: 180 } },
        ],
      },
      'Saved: height 180 cm.',
    );

    const res = await service.chat('my height is 180 cm');

    expect(fitnessRepo.metrics).toEqual([
      { id: 'm-1', name: 'height_cm', date: '2026-07-13', value: 180, unit: null },
    ]);
    const toolTurn = llm.calls[1].messages.at(-1)!;
    expect(JSON.parse(toolTurn.content)).toMatchObject({
      logged: true,
      name: 'height_cm',
      value: 180,
    });
    expect(res.answer).toBe('Saved: height 180 cm.');
  });

  it('runs multi-round tool loops (calls → results → another call → answer)', async () => {
    const service = makeService();
    llm.queue.push(
      {
        content: '',
        toolCalls: [
          { name: 'log_metric', arguments: { name: 'weight_kg', value: 82.4 } },
          { name: 'log_metric', arguments: { name: 'protein_g', value: 160 } },
        ],
      },
      {
        content: '',
        toolCalls: [{ name: 'query_metric', arguments: { query: 'avg', name: 'protein_g' } }],
      },
      'Logged. Your 7-day protein average is 160g.',
    );

    const res = await service.chat('log weight 82.4 and 160g protein, how am I trending?');

    expect(llm.calls).toHaveLength(3);
    expect(fitnessRepo.metrics.map((m) => m.name)).toEqual(['weight_kg', 'protein_g']);
    const avgResult = JSON.parse(llm.calls[2].messages.at(-1)!.content);
    expect(avgResult).toMatchObject({ name: 'protein_g', count: 1, avg: 160 });
    expect(res.answer).toBe('Logged. Your 7-day protein average is 160g.');
  });

  it('feeds bad tool args back as {error} so the model can recover', async () => {
    const service = makeService();
    llm.queue.push(
      { content: '', toolCalls: [{ name: 'log_metric', arguments: { name: 'weight_kg' } }] },
      'What value should I log for your weight?',
    );

    const res = await service.chat('log my weight');

    expect(fitnessRepo.metrics).toHaveLength(0);
    const toolTurn = llm.calls[1].messages.at(-1)!;
    expect(JSON.parse(toolTurn.content).error).toMatch(/value/);
    expect(res.answer).toBe('What value should I log for your weight?');
  });

  it('stops a tool-call-forever model after the round cap', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      llm.queue.push({
        content: '',
        toolCalls: [{ name: 'query_metric', arguments: { query: 'avg', name: 'calories' } }],
      });
    }

    await service.chat('average calories?');
    expect(llm.calls.length).toBe(9); // initial + MAX_TOOL_ROUNDS
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
    expect(system).toContain('do NOT call these tools');
  });
});

describe('ChatService planner (knowledge tools)', () => {
  it('merges save_note into the offered tools + routing prompt, dispatches to KnowledgeToolsService', async () => {
    const service = makeService([], true);
    llm.queue.push(
      {
        content: '',
        toolCalls: [
          {
            name: 'save_note',
            arguments: {
              title: 'ESV preference',
              markdown: 'Prefers the ESV translation for bible study.',
              folder: 'faith',
            },
          },
        ],
      },
      'Saved to faith/esv-preference.md.',
    );

    const res = await service.chat('remember that I prefer the ESV translation');

    // both toolsets offered in one merged list
    expect(llm.calls[0].tools?.map((t) => t.name)).toEqual([
      'log_workout',
      'log_workout_text',
      'log_metric',
      'query_metric',
      'query_fitness',
      'save_note',
      'read_note',
      'list_notes',
      'move_note',
    ]);
    // both routing prompts in the system slot
    const system = llm.calls[0].messages[0].content;
    expect(system).toContain('log_metric');
    expect(system).toContain('save_note');

    // dispatched to the knowledge service, not fitness
    expect(knowledgeService.ingested).toEqual([
      {
        title: 'ESV preference',
        markdown: 'Prefers the ESV translation for bible study.',
        source: 'chat',
        folder: 'faith',
        tags: undefined,
        summary: undefined,
      },
    ]);
    expect(fitnessRepo.workouts).toHaveLength(0);
    const toolTurn = llm.calls[1].messages.at(-1)!;
    expect(toolTurn.toolName).toBe('save_note');
    expect(JSON.parse(toolTurn.content)).toMatchObject({
      saved: true,
      path: 'faith/esv-preference.md',
    });
    expect(res.answer).toBe('Saved to faith/esv-preference.md.');
  });

  it('fitness dispatch still works with both toolsets wired', async () => {
    const service = makeService([], true);
    llm.queue.push(
      {
        content: '',
        toolCalls: [{ name: 'log_metric', arguments: { name: 'weight_kg', value: 82 } }],
      },
      'Logged 82 kg.',
    );

    const res = await service.chat('I weigh 82 kg');

    expect(fitnessRepo.metrics.map((m) => m.name)).toEqual(['weight_kg']);
    expect(knowledgeService.ingested).toHaveLength(0);
    expect(res.answer).toBe('Logged 82 kg.');
  });
});
