import { asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bodyMetrics, workoutSets, workouts } from '../db/schema';

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

export interface BodyMetricRow {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  weightKg: number | null;
  calories: number | null;
  proteinG: number | null;
}

export interface NewWorkoutSet {
  reps: number;
  weightKg: number | null;
}

export interface NewWorkoutExercise {
  exercise: string;
  sets: NewWorkoutSet[];
}

export interface NewBodyMetric {
  date: string;
  weightKg: number | null;
  calories: number | null;
  proteinG: number | null;
}

export type WorkoutWithSets = WorkoutRow & { sets: SetRow[] };

/** Fitness store — parameterized queries only, no free-form SQL. Faked in tests. */
export interface FitnessRepo {
  createWorkout(
    date: string,
    notes: string | null,
    exercises: NewWorkoutExercise[],
  ): Promise<WorkoutWithSets>;
  insertBodyMetric(metric: NewBodyMetric): Promise<BodyMetricRow>;
  /** Rows in [since, until], both inclusive, oldest first. */
  metricsBetween(since: string, until: string): Promise<BodyMetricRow[]>;
  /** All sets for one exercise (already-normalized name), oldest workout first. */
  setsForExercise(exercise: string): Promise<DatedSet[]>;
  /** All sets from workouts dated >= since, oldest first. */
  setsSince(since: string): Promise<DatedSet[]>;
  /** Most recent workouts (date desc) with their sets. */
  recentWorkouts(limit: number): Promise<WorkoutWithSets[]>;
  listMetrics(): Promise<BodyMetricRow[]>;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

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

  async insertBodyMetric(metric: NewBodyMetric): Promise<BodyMetricRow> {
    const [row] = await this.db
      .insert(bodyMetrics)
      .values({
        date: metric.date,
        weightKg: metric.weightKg === null ? null : String(metric.weightKg),
        calories: metric.calories,
        proteinG: metric.proteinG === null ? null : String(metric.proteinG),
      })
      .returning();
    return { ...row, weightKg: num(row.weightKg), proteinG: num(row.proteinG) };
  }

  async metricsBetween(since: string, until: string): Promise<BodyMetricRow[]> {
    const rows = await this.db
      .select()
      .from(bodyMetrics)
      .where(gte(bodyMetrics.date, since))
      .orderBy(asc(bodyMetrics.date));
    // `until` filtered here to keep the query one-sided-index friendly and trivially safe
    return rows
      .filter((r) => r.date <= until)
      .map((r) => ({ ...r, weightKg: num(r.weightKg), proteinG: num(r.proteinG) }));
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

  async listMetrics(): Promise<BodyMetricRow[]> {
    const rows = await this.db
      .select()
      .from(bodyMetrics)
      .orderBy(desc(bodyMetrics.date));
    return rows.map((r) => ({ ...r, weightKg: num(r.weightKg), proteinG: num(r.proteinG) }));
  }
}
