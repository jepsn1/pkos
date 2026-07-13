import { Inject, Injectable, Optional } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import {
  FITNESS_REPO,
  type FitnessRepo,
  type NewWorkoutExercise,
} from './fitness.repo';

/** Injectable clock (tests pin it); defaults to the real one. */
export const FITNESS_NOW = 'FITNESS_NOW';

/** Appended to the chat system prompt so the planner routes fitness turns to tools.
 *  Prefer FitnessToolsService.routingPrompt(), which prepends today's date. */
export const FITNESS_ROUTING = `You also have fitness tools for the user's personal training log.
Routing rules:
- When the user reports a workout, exercises, sets or reps, call log_workout. "AxB" means A separate sets of B reps each ("bench 5x5 at 80kg" = five set entries, each {reps: 5, weight_kg: 80}).
- When the user reports body weight, calories eaten, or protein eaten, call log_body_metric.
- When the user asks about their training or nutrition data (averages, progression, weekly volume, recent workouts), call query_fitness and answer strictly from the tool result.
- For every other question — notes, knowledge, theology, general topics — do NOT call fitness tools; answer from the knowledge items above as instructed.
After a logging tool succeeds, confirm briefly what was saved. Numbers in answers must come from tool results, never invented.`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRICS = ['weight_kg', 'calories', 'protein_g'] as const;
type MetricName = (typeof METRICS)[number];
const QUERIES = [
  'metric_avg',
  'exercise_progression',
  'weekly_volume',
  'recent_workouts',
] as const;

export const FITNESS_TOOLS: LlmTool[] = [
  {
    name: 'log_workout',
    description:
      'Save a workout to the training log. One entry per training session, with every exercise and each set (reps, and weight in kg unless bodyweight).',
    parameters: {
      type: 'object',
      required: ['exercises'],
      properties: {
        date: {
          type: 'string',
          description: 'Workout date YYYY-MM-DD. Omit for today.',
        },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            required: ['exercise', 'sets'],
            properties: {
              exercise: { type: 'string', description: 'Exercise name, e.g. "bench press".' },
              sets: {
                type: 'array',
                description:
                  'One entry per set performed: "5x5 at 80kg" = five entries of {reps: 5, weight_kg: 80}.',
                items: {
                  type: 'object',
                  required: ['reps'],
                  properties: {
                    reps: { type: 'integer', minimum: 1 },
                    weight_kg: {
                      type: 'number',
                      description: 'Weight in kg; omit for bodyweight sets.',
                    },
                  },
                },
              },
            },
          },
        },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'log_body_metric',
    description:
      'Save daily body metrics: body weight (kg), calories eaten, and/or protein eaten (grams). At least one metric is required.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date YYYY-MM-DD. Omit for today.' },
        weight_kg: { type: 'number', description: 'Body weight in kg.' },
        calories: { type: 'integer', description: 'Calories eaten.' },
        protein_g: { type: 'number', description: 'Protein eaten in grams.' },
      },
    },
  },
  {
    name: 'query_fitness',
    description:
      'Query the training log. query=metric_avg: average of a body metric (weight_kg | calories | protein_g) between since and until. query=exercise_progression: per-workout top weight/reps/volume for one exercise. query=weekly_volume: training volume per week since a date. query=recent_workouts: latest workouts with sets.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', enum: [...QUERIES] },
        metric: {
          type: 'string',
          enum: [...METRICS],
          description: 'metric_avg only.',
        },
        since: { type: 'string', description: 'YYYY-MM-DD window start (inclusive).' },
        until: { type: 'string', description: 'YYYY-MM-DD window end (inclusive).' },
        exercise: { type: 'string', description: 'exercise_progression only.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
];

/** Bad tool arguments — reported back to the model as {error}, never thrown out. */
class ToolArgError extends Error {}

type Args = Record<string, unknown>;

@Injectable()
export class FitnessToolsService {
  readonly tools = FITNESS_TOOLS;

  /** Routing rules + today's date (so "today"/"this week" resolve correctly). */
  routingPrompt(): string {
    return `Today's date is ${this.today()}.\n${FITNESS_ROUTING}`;
  }

  constructor(
    @Inject(FITNESS_REPO) private readonly repo: FitnessRepo,
    @Optional() @Inject(FITNESS_NOW) private readonly now: () => Date = () => new Date(),
  ) {}

  /** Run one tool call; result (or {error}) JSON-serialized for the tool message. */
  async execute(call: LlmToolCall): Promise<string> {
    try {
      const args = (call.arguments ?? {}) as Args;
      switch (call.name) {
        case 'log_workout':
          return JSON.stringify(await this.logWorkout(args));
        case 'log_body_metric':
          return JSON.stringify(await this.logBodyMetric(args));
        case 'query_fitness':
          return JSON.stringify(await this.queryFitness(args));
        default:
          return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
    } catch (err) {
      if (err instanceof ToolArgError) return JSON.stringify({ error: err.message });
      throw err;
    }
  }

  async logWorkout(args: Args) {
    const date = this.parseDate(args.date, 'date');
    const notes = optionalString(args.notes, 'notes');
    if (!Array.isArray(args.exercises) || args.exercises.length === 0) {
      throw new ToolArgError('exercises must be a non-empty array');
    }
    const exercises: NewWorkoutExercise[] = args.exercises.map((raw, i) => {
      const ex = asObject(raw, `exercises[${i}]`);
      const name = requiredString(ex.exercise, `exercises[${i}].exercise`)
        .toLowerCase()
        .trim();
      if (!Array.isArray(ex.sets) || ex.sets.length === 0) {
        throw new ToolArgError(`exercises[${i}].sets must be a non-empty array`);
      }
      const sets = ex.sets.map((rawSet, j) => {
        const s = asObject(rawSet, `exercises[${i}].sets[${j}]`);
        return {
          reps: positiveInt(s.reps, `exercises[${i}].sets[${j}].reps`),
          weightKg: optionalPositiveNumber(
            s.weight_kg,
            `exercises[${i}].sets[${j}].weight_kg`,
          ),
        };
      });
      return { exercise: name, sets };
    });

    const workout = await this.repo.createWorkout(date, notes, exercises);
    return {
      logged: true,
      workout_id: workout.id,
      date: workout.date,
      exercises: exercises.map((e) => ({ exercise: e.exercise, sets: e.sets.length })),
      total_sets: workout.sets.length,
    };
  }

  async logBodyMetric(args: Args) {
    const date = this.parseDate(args.date, 'date');
    const weightKg = optionalPositiveNumber(args.weight_kg, 'weight_kg');
    const calories = args.calories == null ? null : positiveInt(args.calories, 'calories');
    const proteinG = optionalPositiveNumber(args.protein_g, 'protein_g');
    if (weightKg === null && calories === null && proteinG === null) {
      throw new ToolArgError(
        'at least one of weight_kg, calories, protein_g is required',
      );
    }
    const row = await this.repo.insertBodyMetric({ date, weightKg, calories, proteinG });
    return {
      logged: true,
      metric_id: row.id,
      date: row.date,
      weight_kg: row.weightKg,
      calories: row.calories,
      protein_g: row.proteinG,
    };
  }

  async queryFitness(args: Args) {
    const query = requiredString(args.query, 'query');
    switch (query) {
      case 'metric_avg':
        return this.metricAvg(args);
      case 'exercise_progression':
        return this.exerciseProgression(args);
      case 'weekly_volume':
        return this.weeklyVolume(args);
      case 'recent_workouts':
        return this.recentWorkouts(args);
      default:
        throw new ToolArgError(`query must be one of: ${QUERIES.join(', ')}`);
    }
  }

  private async metricAvg(args: Args) {
    const metric = requiredString(args.metric, 'metric') as MetricName;
    if (!METRICS.includes(metric)) {
      throw new ToolArgError(`metric must be one of: ${METRICS.join(', ')}`);
    }
    const until = this.parseDate(args.until, 'until');
    const since = args.since == null ? addDays(until, -6) : this.parseDate(args.since, 'since');
    if (since > until) throw new ToolArgError('since must be <= until');
    const rows = await this.repo.metricsBetween(since, until);
    const key = { weight_kg: 'weightKg', calories: 'calories', protein_g: 'proteinG' }[
      metric
    ] as 'weightKg' | 'calories' | 'proteinG';
    const values = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    const avg =
      values.length === 0
        ? null
        : round1(values.reduce((a, b) => a + b, 0) / values.length);
    return { query: 'metric_avg', metric, since, until, count: values.length, avg };
  }

  private async exerciseProgression(args: Args) {
    const exercise = requiredString(args.exercise, 'exercise').toLowerCase().trim();
    const limit = optionalLimit(args.limit, 10);
    const sets = await this.repo.setsForExercise(exercise);
    const byDate = new Map<string, { top: number | null; reps: number; volume: number }>();
    for (const s of sets) {
      const agg = byDate.get(s.date) ?? { top: null, reps: 0, volume: 0 };
      agg.top = s.weightKg === null ? agg.top : Math.max(agg.top ?? 0, s.weightKg);
      agg.reps += s.reps;
      agg.volume += s.reps * (s.weightKg ?? 0);
      byDate.set(s.date, agg);
    }
    const workouts = [...byDate.entries()]
      .map(([date, a]) => ({
        date,
        top_weight_kg: a.top,
        total_reps: a.reps,
        volume_kg: round1(a.volume),
      }))
      .slice(-limit);
    return { query: 'exercise_progression', exercise, workouts };
  }

  private async weeklyVolume(args: Args) {
    const since =
      args.since == null ? addDays(this.today(), -27) : this.parseDate(args.since, 'since');
    const sets = await this.repo.setsSince(since);
    const byWeek = new Map<string, { sets: number; reps: number; volume: number }>();
    for (const s of sets) {
      const week = weekStart(s.date);
      const agg = byWeek.get(week) ?? { sets: 0, reps: 0, volume: 0 };
      agg.sets += 1;
      agg.reps += s.reps;
      agg.volume += s.reps * (s.weightKg ?? 0);
      byWeek.set(week, agg);
    }
    const weeks = [...byWeek.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week_start, a]) => ({
        week_start,
        sets: a.sets,
        reps: a.reps,
        volume_kg: round1(a.volume),
      }));
    return { query: 'weekly_volume', since, weeks };
  }

  private async recentWorkouts(args: Args) {
    const limit = optionalLimit(args.limit, 5);
    const workouts = await this.repo.recentWorkouts(limit);
    return {
      query: 'recent_workouts',
      workouts: workouts.map((w) => ({
        date: w.date,
        notes: w.notes,
        sets: w.sets.map((s) => ({
          exercise: s.exercise,
          set_no: s.setNo,
          reps: s.reps,
          weight_kg: s.weightKg,
        })),
      })),
    };
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private parseDate(value: unknown, field: string): string {
    if (value == null || value === '') return this.today();
    if (typeof value !== 'string' || !DATE_RE.test(value) || isNaN(Date.parse(value))) {
      throw new ToolArgError(`${field} must be a YYYY-MM-DD date`);
    }
    return value;
  }
}

function asObject(v: unknown, field: string): Args {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolArgError(`${field} must be an object`);
  }
  return v as Args;
}

function requiredString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolArgError(`${field} must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown, field: string): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new ToolArgError(`${field} must be a string`);
  return v;
}

function positiveInt(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new ToolArgError(`${field} must be a positive integer`);
  }
  return n;
}

function optionalPositiveNumber(v: unknown, field: string): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new ToolArgError(`${field} must be a positive number`);
  }
  return n;
}

function optionalLimit(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = positiveInt(v, 'limit');
  return Math.min(n, 50);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** YYYY-MM-DD plus/minus days, in UTC. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing the date. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return addDays(date, -sinceMonday);
}
