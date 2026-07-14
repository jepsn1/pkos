import { and, asc, count, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { metricEntries, workoutSets, workouts } from '../db/schema';

export const FITNESS_REPO = 'FITNESS_REPO';

export interface WorkoutRow {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  notes: string | null;
}

export interface SetRow {
  id: string;
  workoutId: string;
  exercise: string;
  setNo: number;
  reps: number;
  weightKg: number | null;
}

/** A set joined with its workout's date (for progression/volume math). */
export type DatedSet = SetRow & { date: string };

export interface MetricRow {
  id: string;
  /** Normalized lowercase snake_case, e.g. weight_kg, sleep_hours. */
  name: string;
  /** YYYY-MM-DD */
  date: string;
  value: number;
  unit: string | null;
}

export interface NewMetric {
  name: string;
  date: string;
  value: number;
  unit: string | null;
}

/** Distinct metric name with entry count and most recent date. */
export interface MetricNameRow {
  name: string;
  count: number;
  lastDate: string;
}

export interface NewWorkoutSet {
  reps: number;
  weightKg: number | null;
}

export interface NewWorkoutExercise {
  exercise: string;
  sets: NewWorkoutSet[];
}

export type WorkoutWithSets = WorkoutRow & { sets: SetRow[] };

/** Fitness store — parameterized queries only, no free-form SQL. Faked in tests. */
export interface FitnessRepo {
  createWorkout(
    date: string,
    notes: string | null,
    exercises: NewWorkoutExercise[],
  ): Promise<WorkoutWithSets>;
  insertMetric(metric: NewMetric): Promise<MetricRow>;
  /** Most recent entry for one (normalized) name; null when never logged. */
  latestMetric(name: string): Promise<MetricRow | null>;
  /** Most recent entry per distinct name, name-ordered. */
  latestMetrics(): Promise<MetricRow[]>;
  /** Entries for one name in [since, until] (null bound = open), oldest first. */
  metricsBetween(
    name: string,
    since: string | null,
    until: string | null,
  ): Promise<MetricRow[]>;
  /** Distinct metric names with counts + last logged date, name-ordered. */
  metricNames(): Promise<MetricNameRow[]>;
  /** All entries (optionally one name), newest first — REST listing. */
  listMetrics(name?: string): Promise<MetricRow[]>;
  /** All sets for one exercise (already-normalized name), oldest workout first. */
  setsForExercise(exercise: string): Promise<DatedSet[]>;
  /** All sets from workouts dated >= since, oldest first. */
  setsSince(since: string): Promise<DatedSet[]>;
  /** Most recent workouts (date desc) with their sets. */
  recentWorkouts(limit: number): Promise<WorkoutWithSets[]>;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const toMetricRow = (r: {
  id: string;
  name: string;
  date: string;
  value: string;
  unit: string | null;
}): MetricRow => ({ id: r.id, name: r.name, date: r.date, value: Number(r.value), unit: r.unit });

export class DrizzleFitnessRepo implements FitnessRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async createWorkout(
    date: string,
    notes: string | null,
    exercises: NewWorkoutExercise[],
  ): Promise<WorkoutWithSets> {
    return this.db.transaction(async (tx) => {
      const [workout] = await tx.insert(workouts).values({ date, notes }).returning();
      const values = exercises.flatMap((ex) =>
        ex.sets.map((s, i) => ({
          workoutId: workout.id,
          exercise: ex.exercise,
          setNo: i + 1,
          reps: s.reps,
          weightKg: s.weightKg === null ? null : String(s.weightKg),
        })),
      );
      const sets = values.length
        ? await tx.insert(workoutSets).values(values).returning()
        : [];
      return { ...workout, sets: sets.map((s) => ({ ...s, weightKg: num(s.weightKg) })) };
    });
  }

  async insertMetric(metric: NewMetric): Promise<MetricRow> {
    const [row] = await this.db
      .insert(metricEntries)
      .values({
        name: metric.name,
        date: metric.date,
        value: String(metric.value),
        unit: metric.unit,
      })
      .returning();
    return toMetricRow(row);
  }

  async latestMetric(name: string): Promise<MetricRow | null> {
    const [row] = await this.db
      .select()
      .from(metricEntries)
      .where(eq(metricEntries.name, name))
      .orderBy(desc(metricEntries.date), desc(metricEntries.created))
      .limit(1);
    return row ? toMetricRow(row) : null;
  }

  async latestMetrics(): Promise<MetricRow[]> {
    const rows = await this.db
      .selectDistinctOn([metricEntries.name])
      .from(metricEntries)
      .orderBy(
        asc(metricEntries.name),
        desc(metricEntries.date),
        desc(metricEntries.created),
      );
    return rows.map(toMetricRow);
  }

  async metricsBetween(
    name: string,
    since: string | null,
    until: string | null,
  ): Promise<MetricRow[]> {
    const conditions = [eq(metricEntries.name, name)];
    if (since !== null) conditions.push(gte(metricEntries.date, since));
    if (until !== null) conditions.push(lte(metricEntries.date, until));
    const rows = await this.db
      .select()
      .from(metricEntries)
      .where(and(...conditions))
      .orderBy(asc(metricEntries.date), asc(metricEntries.created));
    return rows.map(toMetricRow);
  }

  async metricNames(): Promise<MetricNameRow[]> {
    const rows = await this.db
      .select({
        name: metricEntries.name,
        count: count(),
        lastDate: max(metricEntries.date),
      })
      .from(metricEntries)
      .groupBy(metricEntries.name)
      .orderBy(asc(metricEntries.name));
    return rows.map((r) => ({ name: r.name, count: r.count, lastDate: r.lastDate! }));
  }

  async listMetrics(name?: string): Promise<MetricRow[]> {
    const rows = await this.db
      .select()
      .from(metricEntries)
      .where(name === undefined ? undefined : eq(metricEntries.name, name))
      .orderBy(desc(metricEntries.date), desc(metricEntries.created));
    return rows.map(toMetricRow);
  }

  async setsForExercise(exercise: string): Promise<DatedSet[]> {
    const rows = await this.db
      .select({ set: workoutSets, date: workouts.date })
      .from(workoutSets)
      .innerJoin(workouts, eq(workoutSets.workoutId, workouts.id))
      .where(eq(workoutSets.exercise, exercise))
      .orderBy(asc(workouts.date), asc(workoutSets.setNo));
    return rows.map((r) => ({ ...r.set, weightKg: num(r.set.weightKg), date: r.date }));
  }

  async setsSince(since: string): Promise<DatedSet[]> {
    const rows = await this.db
      .select({ set: workoutSets, date: workouts.date })
      .from(workoutSets)
      .innerJoin(workouts, eq(workoutSets.workoutId, workouts.id))
      .where(gte(workouts.date, since))
      .orderBy(asc(workouts.date), asc(workoutSets.setNo));
    return rows.map((r) => ({ ...r.set, weightKg: num(r.set.weightKg), date: r.date }));
  }

  async recentWorkouts(limit: number): Promise<WorkoutWithSets[]> {
    const rows = await this.db
      .select()
      .from(workouts)
      .orderBy(desc(workouts.date))
      .limit(limit);
    if (rows.length === 0) return [];
    const sets = await this.db
      .select()
      .from(workoutSets)
      .where(
        inArray(
          workoutSets.workoutId,
          rows.map((w) => w.id),
        ),
      )
      .orderBy(asc(workoutSets.setNo));
    return rows.map((w) => ({
      ...w,
      sets: sets
        .filter((s) => s.workoutId === w.id)
        .map((s) => ({ ...s, weightKg: num(s.weightKg) })),
    }));
  }
}
