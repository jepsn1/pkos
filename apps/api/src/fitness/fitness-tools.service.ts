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
export const FITNESS_ROUTING = `You also have tools for the user's personal training log and metric log. These routing rules take precedence over the knowledge-base instructions above.
Routing rules:
- When the user reports a workout, exercises, sets or reps, call log_workout. "AxB" means A separate sets of B reps each ("bench 5x5 at 80kg" = five set entries, each {reps: 5, weight_kg: 80}).
- When the user states ANY personal numeric measurement — body weight, height, calories eaten, protein, sleep hours, resting heart rate, mood score, blood pressure, anything with a number — call log_metric. Reuse an existing metric name when one fits; bake the unit into the name (weight_kg, height_cm, sleep_hours, protein_g) or pass it as unit.
- When the user asks anything about their own body or measurements — "what's my height", "how tall am I", "how much do I weigh", "how did I sleep", averages, trends, "what metrics do you have on me" — the answer IS in the metric log: ALWAYS call query_metric before answering (query=latest with the name; no name = every metric). NEVER say you lack access to their information without having called query_metric first. When the tool result is empty, say plainly that nothing is logged yet and offer to log it if they tell you — NEVER tell the user to "log in".
- Broad questions about the user ("what do you know about me?", "tell me about myself") → call query_metric {query: latest} (no name) for their actual current values, then answer in prose combining those values with the knowledge items above. State values directly ("you're 180 cm tall"), not record metadata ("a metric was logged on...").
- When the user asks about training data (exercise progression, weekly volume, recent workouts), call query_fitness.
- For every other question — notes, knowledge, theology, general topics — do NOT call these tools; answer from the knowledge items above as instructed.
Never answer with an announcement like "let me look that up" — emit the tool call itself instead, then answer from its result.
A single message may contain SEVERAL loggable things (e.g. a workout AND sleep AND protein): log every one of them — emit multiple tool calls, in one round or consecutive rounds — before answering. Only confirm what a tool result proves was saved; confirming something you did not log is the worst possible failure.
After a logging tool succeeds, confirm briefly what was saved. Numbers in answers must come from tool results, never invented.`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_QUERIES = ['latest', 'avg', 'series', 'names'] as const;
const QUERIES = ['exercise_progression', 'weekly_volume', 'recent_workouts'] as const;

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
    name: 'log_metric',
    description:
      'Save one dated numeric measurement about the user: body weight, height, calories, protein, sleep hours, resting heart rate, mood — any metric. Reuse an existing metric name when one fits (check query_metric names if unsure) and include the unit in the name (weight_kg, height_cm, sleep_hours, protein_g) or in the unit field.',
    parameters: {
      type: 'object',
      required: ['name', 'value'],
      properties: {
        name: {
          type: 'string',
          description:
            'Metric name, lowercase snake_case with the unit baked in, e.g. weight_kg, height_cm, sleep_hours, resting_hr, mood.',
        },
        value: { type: 'number', description: 'The measured value.' },
        unit: {
          type: 'string',
          description: 'Unit if not already in the name, e.g. "kg", "hours".',
        },
        date: { type: 'string', description: 'Date YYYY-MM-DD. Omit for today.' },
      },
    },
  },
  {
    name: 'query_metric',
    description:
      "Query the user's metric log. query=latest: most recent value for one metric name, or for EVERY metric when name is omitted — use for \"what metrics do you have on me\". query=avg: average of one metric between since and until (default: trailing 7 days). query=series: dated values of one metric over time. query=names: all metric names with entry counts and last logged date.",
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', enum: [...METRIC_QUERIES] },
        name: {
          type: 'string',
          description: 'Metric name, e.g. weight_kg. Required for avg and series.',
        },
        since: { type: 'string', description: 'YYYY-MM-DD window start (inclusive).' },
        until: { type: 'string', description: 'YYYY-MM-DD window end (inclusive).' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'query_fitness',
    description:
      'Query the training log. query=exercise_progression: per-workout top weight/reps/volume for one exercise. query=weekly_volume: training volume per week since a date. query=recent_workouts: latest workouts with sets.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', enum: [...QUERIES] },
        since: { type: 'string', description: 'YYYY-MM-DD window start (inclusive).' },
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
        case 'log_metric':
          return JSON.stringify(await this.logMetric(args));
        case 'query_metric':
          return JSON.stringify(await this.queryMetric(args));
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

  async logMetric(args: Args) {
    const name = normalizeMetricName(requiredString(args.name, 'name'));
    const value = finiteNumber(args.value, 'value');
    const unit = optionalString(args.unit, 'unit');
    const date = this.parseDate(args.date, 'date');
    const row = await this.repo.insertMetric({ name, date, value, unit });
    return {
      logged: true,
      metric_id: row.id,
      name: row.name,
      value: row.value,
      unit: row.unit,
      date: row.date,
    };
  }

  async queryMetric(args: Args) {
    const query = requiredString(args.query, 'query');
    switch (query) {
      case 'latest':
        return this.latestMetric(args);
      case 'avg':
        return this.metricAvg(args);
      case 'series':
        return this.metricSeries(args);
      case 'names':
        return this.metricNames();
      default:
        throw new ToolArgError(`query must be one of: ${METRIC_QUERIES.join(', ')}`);
    }
  }

  /** Latest entry for one name, or the latest entry of EVERY name when omitted. */
  private async latestMetric(args: Args) {
    if (args.name != null && args.name !== '') {
      const name = normalizeMetricName(requiredString(args.name, 'name'));
      const row = await this.repo.latestMetric(name);
      return {
        query: 'latest',
        name,
        entry: row ? { value: row.value, unit: row.unit, date: row.date } : null,
      };
    }
    const rows = await this.repo.latestMetrics();
    return {
      query: 'latest',
      metrics: rows.map((r) => ({
        name: r.name,
        value: r.value,
        unit: r.unit,
        date: r.date,
      })),
    };
  }

  private async metricAvg(args: Args) {
    const name = normalizeMetricName(requiredString(args.name, 'name'));
    const until = this.parseDate(args.until, 'until');
    const since = args.since == null ? addDays(until, -6) : this.parseDate(args.since, 'since');
    if (since > until) throw new ToolArgError('since must be <= until');
    const rows = await this.repo.metricsBetween(name, since, until);
    const avg =
      rows.length === 0
        ? null
        : round1(rows.reduce((a, r) => a + r.value, 0) / rows.length);
    return { query: 'avg', name, since, until, count: rows.length, avg };
  }

  private async metricSeries(args: Args) {
    const name = normalizeMetricName(requiredString(args.name, 'name'));
    const since = args.since == null ? null : this.parseDate(args.since, 'since');
    const until = args.until == null ? null : this.parseDate(args.until, 'until');
    const limit = optionalLimit(args.limit, 50);
    const rows = await this.repo.metricsBetween(name, since, until);
    return {
      query: 'series',
      name,
      entries: rows.slice(-limit).map((r) => ({ date: r.date, value: r.value, unit: r.unit })),
    };
  }

  private async metricNames() {
    const rows = await this.repo.metricNames();
    return {
      query: 'names',
      metrics: rows.map((r) => ({ name: r.name, count: r.count, last_date: r.lastDate })),
    };
  }

  async queryFitness(args: Args) {
    const query = requiredString(args.query, 'query');
    switch (query) {
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

/**
 * Freeform model-supplied metric name → canonical lowercase snake_case:
 * "Weight (kg)" → weight_kg, "Sleep Hours" → sleep_hours, "resting-HR" → resting_hr.
 */
export function normalizeMetricName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) throw new ToolArgError('name must contain letters or digits');
  return name;
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

function finiteNumber(v: unknown, field: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ToolArgError(`${field} must be a number`);
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
