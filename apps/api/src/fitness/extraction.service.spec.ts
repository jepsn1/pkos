import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionService,
  OllamaExtractionLlm,
  type ExtractionLlm,
} from './extraction.service';
import type {
  DatedSet,
  FitnessRepo,
  MetricNameRow,
  MetricRow,
  NewMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from './fitness.repo';

/** Scripted schema-shaped JSON replies; records what it was asked. */
class FakeExtractionLlm implements ExtractionLlm {
  calls: Array<{ system: string; user: string; schema: Record<string, unknown> }> = [];
  reply: string = '{"exercises": [], "general_notes": null}';
  fail: Error | null = null;

  async extractJson(
    system: string,
    user: string,
    schema: Record<string, unknown>,
  ): Promise<string> {
    this.calls.push({ system, user, schema });
    if (this.fail) throw this.fail;
    return this.reply;
  }
}

class FakeRepo implements FitnessRepo {
  workouts: WorkoutWithSets[] = [];
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

  async insertMetric(): Promise<MetricRow> {
    throw new Error('unused');
  }
  async latestMetric(): Promise<MetricRow | null> {
    throw new Error('unused');
  }
  async latestMetrics(): Promise<MetricRow[]> {
    throw new Error('unused');
  }
  async metricsBetween(): Promise<MetricRow[]> {
    throw new Error('unused');
  }
  async metricNames(): Promise<MetricNameRow[]> {
    throw new Error('unused');
  }
  async listMetrics(): Promise<MetricRow[]> {
    throw new Error('unused');
  }
  async setsForExercise(): Promise<DatedSet[]> {
    throw new Error('unused');
  }
  async setsSince(): Promise<DatedSet[]> {
    throw new Error('unused');
  }
  async recentWorkouts(): Promise<WorkoutWithSets[]> {
    throw new Error('unused');
  }
}

let llm: FakeExtractionLlm;
let repo: FakeRepo;
let service: ExtractionService;

beforeEach(() => {
  llm = new FakeExtractionLlm();
  repo = new FakeRepo();
  service = new ExtractionService(llm, repo);
});

describe('ExtractionService.run', () => {
  it('persists parsed exercises with numbered sets, lowercases names, merges notes', async () => {
    llm.reply = JSON.stringify({
      exercises: [
        {
          exercise: '  Machine Fly ',
          sets: [
            { reps: 8, weight_kg: 93 },
            { reps: 8, weight_kg: 93 },
            { reps: 10, weight_kg: 73 },
          ],
          note: 'perfect form',
        },
        {
          exercise: 'Pull-ups',
          sets: [{ reps: 13, weight_kg: null }],
          note: null,
        },
      ],
      general_notes: 'Seat 5, chest 3',
    });

    const res = await service.run('raw gym text', '2026-07-14');

    // llm asked with the focused prompt, verbatim text, strict schema
    expect(llm.calls).toEqual([
      {
        system: EXTRACTION_SYSTEM_PROMPT,
        user: 'raw gym text',
        schema: EXTRACTION_SCHEMA,
      },
    ]);

    expect(res).toEqual({
      logged: true,
      workout_id: 'w-1',
      date: '2026-07-14',
      exercises: 2,
      sets: 4,
      skipped: [],
      notes: 'machine fly: perfect form; Seat 5, chest 3',
    });
    const w = repo.workouts[0];
    expect(w.notes).toBe('machine fly: perfect form; Seat 5, chest 3');
    expect(w.sets.map((s) => [s.exercise, s.setNo, s.reps, s.weightKg])).toEqual([
      ['machine fly', 1, 8, 93],
      ['machine fly', 2, 8, 93],
      ['machine fly', 3, 10, 73],
      ['pull-ups', 1, 13, null],
    ]);
  });

  it('drops out-of-bounds sets and set-less exercises into skipped, keeps the rest', async () => {
    llm.reply = JSON.stringify({
      exercises: [
        {
          exercise: 'curls',
          sets: [
            { reps: 8, weight_kg: 16 },
            { reps: 400, weight_kg: 16 }, // reps > 100
            { reps: 8, weight_kg: 900 }, // weight > 500
            { reps: 0, weight_kg: 16 }, // reps < 1
            { reps: 8.5, weight_kg: 16 }, // non-integer reps
          ],
          note: null,
        },
        { exercise: 'sitting row', sets: [], note: null }, // header, no sets
        { exercise: '', sets: [{ reps: 8, weight_kg: 10 }], note: null }, // nameless
        {
          exercise: 'dips',
          sets: [{ reps: 10, weight_kg: 0 }], // 0 kg → bodyweight
          note: null,
        },
      ],
      general_notes: null,
    });

    const res = await service.run('text', '2026-07-14');

    expect(res.logged).toBe(true);
    expect(res.exercises).toBe(2);
    expect(res.sets).toBe(2);
    expect(res.skipped).toHaveLength(6); // 4 bad sets + set-less header + nameless
    expect(res.skipped.join('\n')).toMatch(/curls.*400/);
    expect(res.skipped.join('\n')).toMatch(/curls.*900/);
    expect(res.skipped.join('\n')).toMatch(/sitting row: no valid sets/);
    expect(res.skipped.join('\n')).toMatch(/exercise with no name/);
    expect(repo.workouts[0].sets.map((s) => [s.exercise, s.reps, s.weightKg])).toEqual([
      ['curls', 8, 16],
      ['dips', 10, null],
    ]);
  });

  it('nothing valid → logged:false with error, nothing persisted', async () => {
    llm.reply = JSON.stringify({
      exercises: [{ exercise: 'x', sets: [{ reps: -1, weight_kg: null }], note: null }],
      general_notes: null,
    });
    const res = await service.run('text', '2026-07-14');
    expect(res.logged).toBe(false);
    expect(res.error).toMatch(/no valid exercises/);
    expect(repo.workouts).toHaveLength(0);
  });

  it('invalid JSON or llm failure → logged:false error, nothing persisted, never throws', async () => {
    llm.reply = 'not json at all';
    const bad = await service.run('text', '2026-07-14');
    expect(bad.logged).toBe(false);
    expect(bad.error).toMatch(/extraction failed/);

    llm.fail = new Error('ollama down');
    const down = await service.run('text', '2026-07-14');
    expect(down.logged).toBe(false);
    expect(down.error).toMatch(/ollama down/);
    expect(repo.workouts).toHaveLength(0);
  });

  it('strips a stray <think> block before parsing', async () => {
    llm.reply = `<think>hmm sets vs reps</think>${JSON.stringify({
      exercises: [{ exercise: 'squat', sets: [{ reps: 5, weight_kg: 100 }], note: null }],
      general_notes: null,
    })}`;
    const res = await service.run('text', '2026-07-14');
    expect(res.logged).toBe(true);
    expect(res.sets).toBe(1);
  });
});

describe('extraction system prompt', () => {
  it('encodes the gym-log disambiguation rules', () => {
    const p = EXTRACTION_SYSTEM_PROMPT;
    expect(p).toContain('A sets of B reps'); // AxB
    expect(p).toContain('2-6'); // set-count range
    expect(p).toContain('5-25'); // rep range
    expect(p).toContain('"12x3" = 3 sets of 12 reps'); // ambiguous NxM
    expect(p).toContain('"124,6" = 124.6'); // European comma decimals
    expect(p).toContain('"28kg, 12,10,9"'); // bare rep list
    expect(p).toContain('CONTINUES the PREVIOUS exercise'); // continuation lines
    expect(p).toContain('"73kg"'); // never a weight-named exercise
    expect(p).toContain('Seat 5, chest 3'); // machine settings → notes
    expect(p).toMatch(/ny form|bedre form/); // form remarks → notes
    expect(p).toContain('"op?"'); // questions → notes
    expect(p).toContain('lowercased'); // keep names verbatim, lowercased
    expect(p).toContain('bodyweight'); // missing weight
  });

  it('schema pins the exact result shape', () => {
    expect(EXTRACTION_SCHEMA).toMatchObject({
      type: 'object',
      required: ['exercises', 'general_notes'],
    });
  });
});

describe('OllamaExtractionLlm', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('POSTs /api/chat with format schema + think, honors EXTRACT_MODEL, strips think', async () => {
    process.env.EXTRACT_MODEL = 'qwen3:8b';
    process.env.LLM_MODEL = 'qwen3:14b';
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return {
        ok: true,
        json: async () => ({ message: { content: '<think>x</think>{"a":1}' } }),
      };
    }) as unknown as typeof fetch;

    const llm = new OllamaExtractionLlm(fakeFetch);
    const out = await llm.extractJson('SYS', 'USER', { type: 'object' });

    expect(out).toBe('{"a":1}');
    expect(captured!.url).toMatch(/\/api\/chat$/);
    expect(captured!.body).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      think: true,
      format: { type: 'object' },
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USER' },
      ],
    });
  });

  it('defaults model to LLM_MODEL; HTTP error and empty content throw', async () => {
    delete process.env.EXTRACT_MODEL;
    process.env.LLM_MODEL = 'qwen3:14b';
    let body: Record<string, unknown> = {};
    const okEmpty = (async (_url: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ message: { content: '' } }) };
    }) as unknown as typeof fetch;
    await expect(
      new OllamaExtractionLlm(okEmpty).extractJson('s', 'u', {}),
    ).rejects.toThrow(/no content/);
    expect(body.model).toBe('qwen3:14b');

    const notOk = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(new OllamaExtractionLlm(notOk).extractJson('s', 'u', {})).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
