import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  FitnessToolsService,
  weekStart,
} from './fitness-tools.service';
import type {
  BodyMetricRow,
  DatedSet,
  FitnessRepo,
  NewBodyMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from './fitness.repo';

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
    return this.metrics
      .filter((m) => m.date >= since && m.date <= until)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async setsForExercise(exercise: string): Promise<DatedSet[]> {
    return this.allSets().filter((s) => s.exercise === exercise);
  }

  async setsSince(since: string): Promise<DatedSet[]> {
    return this.allSets().filter((s) => s.date >= since);
  }

  async recentWorkouts(limit: number): Promise<WorkoutWithSets[]> {
    return [...this.workouts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  async listMetrics(): Promise<BodyMetricRow[]> {
    return [...this.metrics].sort((a, b) => b.date.localeCompare(a.date));
  }

  private allSets(): DatedSet[] {
    return this.workouts
      .sort((a, b) => a.date.localeCompare(b.date))
      .flatMap((w) => w.sets.map((s) => ({ ...s, date: w.date })));
  }
}

// Fixed "today": Monday 2026-07-13
const TODAY = '2026-07-13';
let repo: FakeFitnessRepo;
let service: FitnessToolsService;

beforeEach(() => {
  repo = new FakeFitnessRepo();
  service = new FitnessToolsService(repo, () => new Date(`${TODAY}T10:00:00Z`));
});

async function run(name: string, args: Record<string, unknown>) {
  return JSON.parse(await service.execute({ name, arguments: args }));
}

describe('log_workout', () => {
  it('persists workout + numbered sets, defaults date to today, normalizes names', async () => {
    const res = await run('log_workout', {
      exercises: [
        {
          exercise: '  Bench Press ',
          sets: [
            { reps: 5, weight_kg: 80 },
            { reps: 5, weight_kg: 80 },
          ],
        },
        { exercise: 'Pull-up', sets: [{ reps: 8 }] },
      ],
      notes: 'felt strong',
    });

    expect(res).toMatchObject({ logged: true, date: TODAY, total_sets: 3 });
    const w = repo.workouts[0];
    expect(w.notes).toBe('felt strong');
    expect(w.sets.map((s) => [s.exercise, s.setNo, s.reps, s.weightKg])).toEqual([
      ['bench press', 1, 5, 80],
      ['bench press', 2, 5, 80],
      ['pull-up', 1, 8, null],
    ]);
  });

  it('accepts explicit date, rejects bad dates and bad reps as {error}', async () => {
    const ok = await run('log_workout', {
      date: '2026-07-10',
      exercises: [{ exercise: 'squat', sets: [{ reps: 5, weight_kg: 100 }] }],
    });
    expect(ok.date).toBe('2026-07-10');

    for (const args of [
      { date: 'yesterday', exercises: [{ exercise: 'squat', sets: [{ reps: 5 }] }] },
      { exercises: [] },
      { exercises: [{ exercise: 'squat', sets: [{ reps: -3 }] }] },
      { exercises: [{ exercise: 'squat', sets: [{ reps: 5, weight_kg: 'heavy' }] }] },
      { exercises: [{ exercise: '', sets: [{ reps: 5 }] }] },
    ]) {
      const res = await run('log_workout', args);
      expect(res.error, JSON.stringify(args)).toBeDefined();
    }
    expect(repo.workouts).toHaveLength(1); // only the good one landed
  });
});

describe('log_body_metric', () => {
  it('persists a metric row with defaulted date', async () => {
    const res = await run('log_body_metric', { weight_kg: 82.4, protein_g: 160 });
    expect(res).toMatchObject({
      logged: true,
      date: TODAY,
      weight_kg: 82.4,
      calories: null,
      protein_g: 160,
    });
    expect(repo.metrics).toHaveLength(1);
  });

  it('rejects all-null metrics and bad values as {error}', async () => {
    expect((await run('log_body_metric', {})).error).toMatch(/at least one/);
    expect((await run('log_body_metric', { date: '2026-07-10' })).error).toMatch(
      /at least one/,
    );
    expect((await run('log_body_metric', { calories: 12.5 })).error).toBeDefined();
    expect((await run('log_body_metric', { weight_kg: -3 })).error).toBeDefined();
    expect(repo.metrics).toHaveLength(0);
  });
});

describe('query_fitness metric_avg', () => {
  beforeEach(async () => {
    for (const [date, protein_g] of [
      ['2026-07-07', 150], // Tue this week
      ['2026-07-10', 170],
      ['2026-07-13', 160],
      ['2026-06-01', 999], // outside window
    ] as const) {
      await repo.insertBodyMetric({
        date,
        weightKg: null,
        calories: null,
        proteinG: protein_g,
      });
    }
    await repo.insertBodyMetric({
      date: '2026-07-12',
      weightKg: 82.4,
      calories: 2500,
      proteinG: null, // must be ignored by protein avg
    });
  });

  it('averages only non-null values inside [since, until]', async () => {
    const res = await run('query_fitness', {
      query: 'metric_avg',
      metric: 'protein_g',
      since: '2026-07-07',
      until: '2026-07-13',
    });
    expect(res).toEqual({
      query: 'metric_avg',
      metric: 'protein_g',
      since: '2026-07-07',
      until: '2026-07-13',
      count: 3,
      avg: 160,
    });
  });

  it('defaults window to the last 7 days ending today', async () => {
    const res = await run('query_fitness', { query: 'metric_avg', metric: 'protein_g' });
    expect(res.since).toBe(addDays(TODAY, -6));
    expect(res.until).toBe(TODAY);
    expect(res.count).toBe(3);
    expect(res.avg).toBe(160);
  });

  it('null avg on empty window; rejects bad metric and inverted window', async () => {
    const empty = await run('query_fitness', {
      query: 'metric_avg',
      metric: 'calories',
      since: '2020-01-01',
      until: '2020-01-07',
    });
    expect(empty).toMatchObject({ count: 0, avg: null });

    expect(
      (await run('query_fitness', { query: 'metric_avg', metric: 'steps' })).error,
    ).toMatch(/metric must be one of/);
    expect(
      (
        await run('query_fitness', {
          query: 'metric_avg',
          metric: 'calories',
          since: '2026-07-13',
          until: '2026-07-01',
        })
      ).error,
    ).toMatch(/since must be <= until/);
  });
});

describe('query_fitness exercise_progression', () => {
  it('aggregates per workout date: top weight, total reps, volume; honors limit', async () => {
    await repo.createWorkout('2026-07-01', null, [
      {
        exercise: 'bench press',
        sets: [
          { reps: 5, weightKg: 75 },
          { reps: 5, weightKg: 77.5 },
        ],
      },
    ]);
    await repo.createWorkout('2026-07-08', null, [
      { exercise: 'bench press', sets: [{ reps: 5, weightKg: 80 }] },
      { exercise: 'squat', sets: [{ reps: 5, weightKg: 100 }] },
    ]);

    const res = await run('query_fitness', {
      query: 'exercise_progression',
      exercise: 'Bench Press', // normalized before repo lookup
    });
    expect(res.workouts).toEqual([
      { date: '2026-07-01', top_weight_kg: 77.5, total_reps: 10, volume_kg: 762.5 },
      { date: '2026-07-08', top_weight_kg: 80, total_reps: 5, volume_kg: 400 },
    ]);

    const limited = await run('query_fitness', {
      query: 'exercise_progression',
      exercise: 'bench press',
      limit: 1,
    });
    expect(limited.workouts.map((w: { date: string }) => w.date)).toEqual(['2026-07-08']);
  });

  it('requires exercise', async () => {
    const res = await run('query_fitness', { query: 'exercise_progression' });
    expect(res.error).toMatch(/exercise/);
  });
});

describe('query_fitness weekly_volume', () => {
  it('groups by ISO week (Monday start); bodyweight sets add reps, zero volume', async () => {
    await repo.createWorkout('2026-07-06', null, [
      { exercise: 'squat', sets: [{ reps: 5, weightKg: 100 }] }, // Mon wk1
    ]);
    await repo.createWorkout('2026-07-12', null, [
      { exercise: 'pull-up', sets: [{ reps: 10, weightKg: null }] }, // Sun wk1
    ]);
    await repo.createWorkout('2026-07-13', null, [
      { exercise: 'squat', sets: [{ reps: 3, weightKg: 110 }] }, // Mon wk2
    ]);

    const res = await run('query_fitness', { query: 'weekly_volume', since: '2026-07-06' });
    expect(res.weeks).toEqual([
      { week_start: '2026-07-06', sets: 2, reps: 15, volume_kg: 500 },
      { week_start: '2026-07-13', sets: 1, reps: 3, volume_kg: 330 },
    ]);
  });
});

describe('query_fitness recent_workouts + dispatch', () => {
  it('returns latest workouts with sets', async () => {
    await repo.createWorkout('2026-07-01', 'old', [
      { exercise: 'squat', sets: [{ reps: 5, weightKg: 100 }] },
    ]);
    await repo.createWorkout('2026-07-13', 'new', [
      { exercise: 'bench press', sets: [{ reps: 5, weightKg: 80 }] },
    ]);

    const res = await run('query_fitness', { query: 'recent_workouts', limit: 1 });
    expect(res.workouts).toEqual([
      {
        date: '2026-07-13',
        notes: 'new',
        sets: [{ exercise: 'bench press', set_no: 1, reps: 5, weight_kg: 80 }],
      },
    ]);
  });

  it('unknown query and unknown tool → {error}', async () => {
    expect((await run('query_fitness', { query: 'drop_tables' })).error).toMatch(
      /query must be one of/,
    );
    expect((await run('nuke_db', {})).error).toMatch(/unknown tool/);
  });
});

describe('date helpers', () => {
  it('addDays and weekStart', () => {
    expect(addDays('2026-07-13', -6)).toBe('2026-07-07');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekStart('2026-07-13')).toBe('2026-07-13'); // Monday
    expect(weekStart('2026-07-12')).toBe('2026-07-06'); // Sunday
  });
});
