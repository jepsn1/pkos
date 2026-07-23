import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  FitnessToolsService,
  nameSimilarity,
  normalizeMetricName,
  weekStart,
} from './fitness-tools.service';
import type { ExtractionService } from './extraction.service';
import type {
  DatedSet,
  FitnessRepo,
  MetricNameRow,
  MetricRow,
  NewMetric,
  NewWorkoutExercise,
  WorkoutWithSets,
} from './fitness.repo';

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
    return this.metrics
      .filter(
        (m) =>
          m.name === name &&
          (since === null || m.date >= since) &&
          (until === null || m.date <= until),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async metricNames(): Promise<MetricNameRow[]> {
    const byName = new Map<string, MetricRow[]>();
    for (const m of this.metrics) {
      byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
    }
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => ({
        name,
        count: rows.length,
        lastDate: rows.map((r) => r.date).sort().at(-1)!,
      }));
  }

  async listMetrics(name?: string): Promise<MetricRow[]> {
    return this.metrics
      .filter((m) => name === undefined || m.name === name)
      .sort((a, b) => b.date.localeCompare(a.date));
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

describe('log_workout_text', () => {
  it('dispatches raw_text verbatim + defaulted date to the extraction service', async () => {
    const runs: Array<{ rawText: string; date: string }> = [];
    const extraction = {
      run: async (rawText: string, date: string) => {
        runs.push({ rawText, date });
        return { logged: true, workout_id: 'w-9', date, exercises: 2, sets: 6, skipped: [], notes: null };
      },
    } as unknown as ExtractionService;
    const svc = new FitnessToolsService(repo, () => new Date(`${TODAY}T10:00:00Z`), extraction);

    const res = JSON.parse(
      await svc.execute({
        name: 'log_workout_text',
        arguments: { raw_text: 'Flys 24kg 3x8\n73kg 3x10 perfect form' },
      }),
    );
    expect(runs).toEqual([{ rawText: 'Flys 24kg 3x8\n73kg 3x10 perfect form', date: TODAY }]);
    expect(res).toMatchObject({ logged: true, exercises: 2, sets: 6 });

    // explicit date passes through
    await svc.execute({
      name: 'log_workout_text',
      arguments: { raw_text: 'x', date: '2026-07-10' },
    });
    expect(runs[1].date).toBe('2026-07-10');
  });

  it('requires raw_text; errors cleanly when extraction is not wired', async () => {
    const extraction = { run: async () => ({}) } as unknown as ExtractionService;
    const svc = new FitnessToolsService(repo, () => new Date(`${TODAY}T10:00:00Z`), extraction);
    expect(
      JSON.parse(await svc.execute({ name: 'log_workout_text', arguments: {} })).error,
    ).toMatch(/raw_text/);
    expect(
      JSON.parse(
        await svc.execute({ name: 'log_workout_text', arguments: { raw_text: 'x', date: 'nope' } }),
      ).error,
    ).toMatch(/date/);
    // service (built without extraction in beforeEach) reports unavailability as {error}
    expect(
      (await run('log_workout_text', { raw_text: 'bench 5x5 80kg' })).error,
    ).toMatch(/unavailable/);
  });
});

describe('normalizeMetricName', () => {
  it('lowercases and snake_cases freeform names', () => {
    expect(normalizeMetricName('weight_kg')).toBe('weight_kg');
    expect(normalizeMetricName('Weight (kg)')).toBe('weight_kg');
    expect(normalizeMetricName('  Sleep Hours ')).toBe('sleep_hours');
    expect(normalizeMetricName('resting-HR')).toBe('resting_hr');
    expect(normalizeMetricName('Height_CM')).toBe('height_cm');
  });
});

describe('log_metric', () => {
  it('persists a normalized entry with defaulted date', async () => {
    const res = await run('log_metric', { name: 'Height (cm)', value: 180 });
    expect(res).toEqual({
      logged: true,
      metric_id: 'm-1',
      name: 'height_cm',
      value: 180,
      unit: null,
      date: TODAY,
    });
    expect(repo.metrics).toEqual([
      { id: 'm-1', name: 'height_cm', date: TODAY, value: 180, unit: null },
    ]);
  });

  it('keeps unit and explicit date; accepts fractional values', async () => {
    const res = await run('log_metric', {
      name: 'sleep_hours',
      value: 6.5,
      unit: 'hours',
      date: '2026-07-12',
    });
    expect(res).toMatchObject({
      name: 'sleep_hours',
      value: 6.5,
      unit: 'hours',
      date: '2026-07-12',
    });
  });

  it('rejects missing name/value, non-numeric value, bad date as {error}', async () => {
    expect((await run('log_metric', { value: 80 })).error).toMatch(/name/);
    expect((await run('log_metric', { name: '!!!', value: 80 })).error).toMatch(/name/);
    expect((await run('log_metric', { name: 'weight_kg' })).error).toMatch(/value/);
    expect((await run('log_metric', { name: 'weight_kg', value: 'heavy' })).error).toMatch(
      /value/,
    );
    expect(
      (await run('log_metric', { name: 'weight_kg', value: 80, date: 'yesterday' })).error,
    ).toMatch(/date/);
    expect(repo.metrics).toHaveLength(0);
  });
});

describe('query_metric latest', () => {
  it('returns the most recent entry for one name (normalized before lookup)', async () => {
    repo.metrics.push(
      { id: 'm1', name: 'weight_kg', date: '2026-07-10', value: 84, unit: null },
      { id: 'm2', name: 'weight_kg', date: '2026-07-12', value: 83, unit: null },
      { id: 'm3', name: 'height_cm', date: '2026-07-01', value: 180, unit: null },
    );
    const res = await run('query_metric', { query: 'latest', name: 'Weight (kg)' });
    expect(res).toEqual({
      query: 'latest',
      name: 'weight_kg',
      entry: { value: 83, unit: null, date: '2026-07-12' },
    });
  });

  it('null entry when the name was never logged', async () => {
    const res = await run('query_metric', { query: 'latest', name: 'mood' });
    expect(res).toEqual({ query: 'latest', name: 'mood', entry: null });
  });

  it('without name: latest entry of EVERY metric', async () => {
    repo.metrics.push(
      { id: 'm1', name: 'weight_kg', date: '2026-07-10', value: 84, unit: null },
      { id: 'm2', name: 'weight_kg', date: '2026-07-12', value: 83, unit: null },
      { id: 'm3', name: 'sleep_hours', date: '2026-07-13', value: 6.5, unit: 'hours' },
    );
    const res = await run('query_metric', { query: 'latest' });
    expect(res).toEqual({
      query: 'latest',
      metrics: [
        { name: 'sleep_hours', value: 6.5, unit: 'hours', date: '2026-07-13' },
        { name: 'weight_kg', value: 83, unit: null, date: '2026-07-12' },
      ],
    });
  });

  it('empty metrics array when nothing logged at all', async () => {
    const res = await run('query_metric', { query: 'latest' });
    expect(res).toEqual({ query: 'latest', metrics: [] });
  });
});

describe('query_metric fuzzy name recall', () => {
  beforeEach(() => {
    repo.metrics.push(
      { id: 'm1', name: 'body_fat_pct', date: '2026-07-22', value: 12.5, unit: '%' },
      { id: 'm2', name: 'muscle_mass_kg', date: '2026-07-22', value: 64.5, unit: 'kg' },
      { id: 'm3', name: 'weight_kg', date: '2026-07-20', value: 76.8, unit: 'kg' },
    );
  });

  it('resolves a near-miss name to the logged metric (latest)', async () => {
    const res = await run('query_metric', { query: 'latest', name: 'body fat' });
    expect(res).toEqual({
      query: 'latest',
      name: 'body_fat_pct',
      entry: { value: 12.5, unit: '%', date: '2026-07-22' },
    });
  });

  it('resolves "muscle mass" to muscle_mass_kg', async () => {
    const res = await run('query_metric', { query: 'latest', name: 'muscle mass' });
    expect(res.name).toBe('muscle_mass_kg');
    expect(res.entry.value).toBe(64.5);
  });

  it('resolves an unsegmented guess via substring ("bodyfat")', async () => {
    const res = await run('query_metric', { query: 'latest', name: 'bodyfat' });
    expect(res.name).toBe('body_fat_pct');
  });

  it('returns candidates (not a value) when the guess is ambiguous', async () => {
    repo.metrics.push({ id: 'm4', name: 'body_fat_kg', date: '2026-07-22', value: 9.6, unit: 'kg' });
    const res = await run('query_metric', { query: 'latest', name: 'body fat' });
    expect(res.entry).toBeNull();
    expect(res.candidates).toEqual(['body_fat_kg', 'body_fat_pct']);
  });

  it('reports nothing logged (null) when no name is even close', async () => {
    const res = await run('query_metric', { query: 'latest', name: 'sleep' });
    expect(res).toEqual({ query: 'latest', name: 'sleep', entry: null });
  });

  it('fuzzy recall works for avg and series too', async () => {
    repo.metrics.push({ id: 'm5', name: 'body_fat_pct', date: '2026-07-23', value: 12.1, unit: '%' });
    const avg = await run('query_metric', {
      query: 'avg',
      name: 'body fat',
      since: '2026-07-01',
      until: '2026-07-31',
    });
    expect(avg.name).toBe('body_fat_pct');
    expect(avg.avg).toBe(12.3);
    const series = await run('query_metric', { query: 'series', name: 'body fat' });
    expect(series.name).toBe('body_fat_pct');
    expect(series.entries).toHaveLength(2);
  });
});

describe('nameSimilarity', () => {
  it('scores shared tokens, weak substring, and zero for unrelated', () => {
    expect(nameSimilarity('body_fat', 'body_fat_pct')).toBe(2);
    expect(nameSimilarity('weight', 'weight_kg')).toBe(1);
    expect(nameSimilarity('bodyfat', 'body_fat_pct')).toBe(0.5);
    expect(nameSimilarity('sleep', 'body_fat_pct')).toBe(0);
  });
});

describe('query_metric avg', () => {
  beforeEach(() => {
    repo.metrics.push(
      { id: 'm1', name: 'protein_g', date: '2026-07-07', value: 150, unit: null },
      { id: 'm2', name: 'protein_g', date: '2026-07-10', value: 170, unit: null },
      { id: 'm3', name: 'protein_g', date: '2026-07-13', value: 160, unit: null },
      { id: 'm4', name: 'protein_g', date: '2026-06-01', value: 999, unit: null }, // outside window
      { id: 'm5', name: 'weight_kg', date: '2026-07-12', value: 82.4, unit: null }, // other metric
    );
  });

  it('averages only the named metric inside [since, until]', async () => {
    const res = await run('query_metric', {
      query: 'avg',
      name: 'protein_g',
      since: '2026-07-07',
      until: '2026-07-13',
    });
    expect(res).toEqual({
      query: 'avg',
      name: 'protein_g',
      since: '2026-07-07',
      until: '2026-07-13',
      count: 3,
      avg: 160,
    });
  });

  it('defaults window to the last 7 days ending today', async () => {
    const res = await run('query_metric', { query: 'avg', name: 'protein_g' });
    expect(res.since).toBe(addDays(TODAY, -6));
    expect(res.until).toBe(TODAY);
    expect(res.count).toBe(3);
    expect(res.avg).toBe(160);
  });

  it('null avg on empty window; requires name; rejects inverted window', async () => {
    const empty = await run('query_metric', {
      query: 'avg',
      name: 'calories',
      since: '2020-01-01',
      until: '2020-01-07',
    });
    expect(empty).toMatchObject({ count: 0, avg: null });

    expect((await run('query_metric', { query: 'avg' })).error).toMatch(/name/);
    expect(
      (
        await run('query_metric', {
          query: 'avg',
          name: 'protein_g',
          since: '2026-07-13',
          until: '2026-07-01',
        })
      ).error,
    ).toMatch(/since must be <= until/);
  });
});

describe('query_metric series', () => {
  it('returns dated values oldest-first, window + limit honored', async () => {
    repo.metrics.push(
      { id: 'm1', name: 'weight_kg', date: '2026-07-01', value: 85, unit: null },
      { id: 'm2', name: 'weight_kg', date: '2026-07-07', value: 84, unit: null },
      { id: 'm3', name: 'weight_kg', date: '2026-07-13', value: 83, unit: null },
      { id: 'm4', name: 'mood', date: '2026-07-13', value: 7, unit: null },
    );
    const res = await run('query_metric', { query: 'series', name: 'weight_kg' });
    expect(res).toEqual({
      query: 'series',
      name: 'weight_kg',
      entries: [
        { date: '2026-07-01', value: 85, unit: null },
        { date: '2026-07-07', value: 84, unit: null },
        { date: '2026-07-13', value: 83, unit: null },
      ],
    });

    const windowed = await run('query_metric', {
      query: 'series',
      name: 'weight_kg',
      since: '2026-07-05',
      limit: 1,
    });
    expect(windowed.entries).toEqual([{ date: '2026-07-13', value: 83, unit: null }]);
  });

  it('empty entries when nothing logged; requires name', async () => {
    const res = await run('query_metric', { query: 'series', name: 'steps' });
    expect(res).toEqual({ query: 'series', name: 'steps', entries: [] });
    expect((await run('query_metric', { query: 'series' })).error).toMatch(/name/);
  });
});

describe('query_metric names', () => {
  it('lists distinct names with counts and last date', async () => {
    repo.metrics.push(
      { id: 'm1', name: 'weight_kg', date: '2026-07-10', value: 84, unit: null },
      { id: 'm2', name: 'weight_kg', date: '2026-07-12', value: 83, unit: null },
      { id: 'm3', name: 'height_cm', date: '2026-07-01', value: 180, unit: null },
    );
    const res = await run('query_metric', { query: 'names' });
    expect(res).toEqual({
      query: 'names',
      metrics: [
        { name: 'height_cm', count: 1, last_date: '2026-07-01' },
        { name: 'weight_kg', count: 2, last_date: '2026-07-12' },
      ],
    });
  });

  it('empty list when nothing logged; unknown query → {error}', async () => {
    expect(await run('query_metric', { query: 'names' })).toEqual({
      query: 'names',
      metrics: [],
    });
    expect((await run('query_metric', { query: 'drop_tables' })).error).toMatch(
      /query must be one of/,
    );
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

  it('removed metric queries and unknown tools → {error}', async () => {
    expect((await run('query_fitness', { query: 'latest_metrics' })).error).toMatch(
      /query must be one of/,
    );
    expect((await run('query_fitness', { query: 'metric_avg' })).error).toMatch(
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
