import { Inject, Injectable } from '@nestjs/common';
import { LLM_FETCH, stripThink } from '../chat/llm.provider';
import { FITNESS_REPO, type FitnessRepo, type NewWorkoutExercise } from './fitness.repo';

export const EXTRACT_LLM = 'EXTRACT_LLM';

/** Dedicated structured-output LLM call for gym-log extraction. Faked in tests. */
export interface ExtractionLlm {
  /** Returns the model's raw content string (constrained to `schema` by ollama). */
  extractJson(
    system: string,
    user: string,
    schema: Record<string, unknown>,
  ): Promise<string>;
}

/** JSON Schema handed to ollama's `format` — constrained decoding guarantees shape.
 *  Set GROUPS, not individual sets: "3x8 @ 93kg" is ONE {sets:3, reps:8, weight_kg:93}
 *  — the model never has to repeat identical objects (qwen3 collapses repetition),
 *  the server expands groups into per-set rows. */
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['exercises', 'general_notes'],
  properties: {
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        required: ['exercise', 'groups', 'note'],
        properties: {
          exercise: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sets', 'reps', 'weight_kg'],
              properties: {
                sets: { type: 'integer' },
                reps: { type: 'integer' },
                weight_kg: { type: ['number', 'null'] },
              },
            },
          },
          note: { type: ['string', 'null'] },
        },
      },
    },
    general_notes: { type: ['string', 'null'] },
  },
};

/** The gym-log disambiguation rules live HERE (not in chat routing): a focused
 *  system prompt for the dedicated extraction call. */
export const EXTRACTION_SYSTEM_PROMPT = `You convert ONE raw gym-workout log into JSON. The text is real and messy: any language (often Danish/English mix), typos, shorthand. Output ONLY the JSON.

Each exercise gets set GROUPS: {"sets": how many sets, "reps": reps per set, "weight_kg": weight or null}.

Rules:
- Keep the user's own exercise names verbatim (any language), lowercased. Never translate or rename.
- "AxB" means A sets of B reps: "3x8 93kg" = one group {"sets": 3, "reps": 8, "weight_kg": 93}. "5x5 80kg" = {"sets": 5, "reps": 5, "weight_kg": 80}.
- Set counts are realistically 2-6 and reps 5-25. When AxB is ambiguous ("12x3", "15x3", "14x3"), the number in the 2-6 range is the SET count and the other is the reps: "12x3" = 3 sets of 12 reps ({"sets": 3, "reps": 12}), NEVER 12 sets of 3. Only read AxB as reps-first like this when A is outside 2-6 and B is inside it.
- Comma decimals are European: "10,5kg" = 10.5 kg, "124,6" = 124.6, "15,8kg" = 15.8.
- A weight followed by a comma-separated rep list is one single-set group per rep count: "28kg, 12,10,9" = three groups [{"sets":1,"reps":12,"weight_kg":28},{"sets":1,"reps":10,"weight_kg":28},{"sets":1,"reps":9,"weight_kg":28}] (descending reps are normal). "86kg 12,7" = two groups (12 reps, then 7 reps, both 86 kg).
- A line/segment with ONLY numbers — weight and/or reps but NO exercise name (e.g. "73kg 3x10", "13,5kg 8,10,10") — CONTINUES the PREVIOUS exercise: append its groups to that same exercise (a different weight on the same movement). NEVER invent an exercise named after a weight like "73kg" or "13,5kg".
- No weight given (e.g. "pull-ups 3x13") → weight_kg null (bodyweight).
- Machine/equipment settings ("Seat 5, chest 3"), form remarks ("ny form", "bedre form", "perfect form", "perfekt form"), and questions ("op?", "increase?") are NEVER groups and NEVER exercises: put them in the note of the exercise they follow, or in general_notes if they follow nothing.
- An exercise name with NO numbers at all (e.g. a bare "sitting row" header) gets groups: [] and a mention in general_notes — do not invent sets for it.
- Weights are kg. EVERY line of the log must be accounted for — as an exercise, appended groups, or a note. Never drop a line, never mix one exercise's weight into another.

Example input:
Machine fly 93kg 3x8
73kg 3x10 perfect form
Incline dumbbell press 28kg, 12,10,9
Seat 5, chest 3
Pull-ups 3x13
Sitting row

Example output:
{"exercises":[{"exercise":"machine fly","groups":[{"sets":3,"reps":8,"weight_kg":93},{"sets":3,"reps":10,"weight_kg":73}],"note":"perfect form"},{"exercise":"incline dumbbell press","groups":[{"sets":1,"reps":12,"weight_kg":28},{"sets":1,"reps":10,"weight_kg":28},{"sets":1,"reps":9,"weight_kg":28}],"note":"Seat 5, chest 3"},{"exercise":"pull-ups","groups":[{"sets":3,"reps":13,"weight_kg":null}],"note":null}],"general_notes":"sitting row (no sets given)"}`;

/** One parsed+validated extraction result, as returned to the chat model. */
export interface ExtractionSummary {
  logged: boolean;
  workout_id?: string;
  date: string;
  exercises: number;
  sets: number;
  skipped: string[];
  notes: string | null;
  error?: string;
}

interface ParsedGroup {
  sets?: unknown;
  reps?: unknown;
  weight_kg?: unknown;
}
interface ParsedExercise {
  exercise?: unknown;
  groups?: unknown;
  note?: unknown;
}

const MAX_SETS_PER_GROUP = 10;
const MAX_REPS = 100;
const MAX_WEIGHT_KG = 500;

/**
 * Server-side gym-log parsing: the chat model hands over the user's raw text
 * verbatim (tiny tool call); a dedicated ollama structured-output call does the
 * heavy parsing, the result is validated and persisted via the fitness repo.
 */
@Injectable()
export class ExtractionService {
  constructor(
    @Inject(EXTRACT_LLM) private readonly llm: ExtractionLlm,
    @Inject(FITNESS_REPO) private readonly repo: FitnessRepo,
  ) {}

  /** Extract `rawText` into a workout dated `date` (already-validated YYYY-MM-DD). */
  async run(rawText: string, date: string): Promise<ExtractionSummary> {
    const empty = { date, exercises: 0, sets: 0, notes: null };
    let parsed: { exercises?: unknown; general_notes?: unknown };
    try {
      const content = await this.llm.extractJson(
        EXTRACTION_SYSTEM_PROMPT,
        rawText,
        EXTRACTION_SCHEMA,
      );
      parsed = JSON.parse(stripThink(content)) as typeof parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { logged: false, ...empty, skipped: [], error: `extraction failed: ${msg}` };
    }

    const skipped: string[] = [];
    const noteParts: string[] = [];
    const exercises: NewWorkoutExercise[] = [];

    const rawExercises = Array.isArray(parsed.exercises) ? parsed.exercises : [];
    for (const raw of rawExercises as ParsedExercise[]) {
      const name =
        typeof raw?.exercise === 'string' ? raw.exercise.toLowerCase().trim() : '';
      if (!name) {
        skipped.push('exercise with no name');
        continue;
      }
      if (typeof raw.note === 'string' && raw.note.trim()) {
        noteParts.push(`${name}: ${raw.note.trim()}`);
      }
      const sets: Array<{ reps: number; weightKg: number | null }> = [];
      for (const group of (Array.isArray(raw.groups) ? raw.groups : []) as ParsedGroup[]) {
        const count = group?.sets;
        if (
          typeof count !== 'number' ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > MAX_SETS_PER_GROUP
        ) {
          skipped.push(
            `${name}: group dropped (sets ${JSON.stringify(count)} out of 1-${MAX_SETS_PER_GROUP})`,
          );
          continue;
        }
        const reps = group.reps;
        if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) {
          skipped.push(
            `${name}: group dropped (reps ${JSON.stringify(reps)} out of 1-${MAX_REPS})`,
          );
          continue;
        }
        let weight = group.weight_kg ?? null;
        if (weight === 0) weight = null; // 0 kg = bodyweight
        if (
          weight !== null &&
          (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT_KG)
        ) {
          skipped.push(
            `${name}: group dropped (weight ${JSON.stringify(weight)} out of 0-${MAX_WEIGHT_KG} kg)`,
          );
          continue;
        }
        for (let i = 0; i < count; i++) sets.push({ reps, weightKg: weight as number | null });
      }
      if (sets.length === 0) {
        skipped.push(`${name}: no valid sets`);
        continue;
      }
      exercises.push({ exercise: name, sets });
    }

    if (typeof parsed.general_notes === 'string' && parsed.general_notes.trim()) {
      noteParts.push(parsed.general_notes.trim());
    }
    const notes = noteParts.length > 0 ? noteParts.join('; ') : null;

    if (exercises.length === 0) {
      return {
        logged: false,
        ...empty,
        skipped,
        notes,
        error: 'no valid exercises parsed from the text',
      };
    }

    const workout = await this.repo.createWorkout(date, notes, exercises);
    return {
      logged: true,
      workout_id: workout.id,
      date: workout.date,
      exercises: exercises.length,
      sets: workout.sets.length,
      skipped,
      notes,
    };
  }
}

/** Real impl: ollama /api/chat with `format: schema` (structured outputs) and
 *  think enabled — parse quality over latency; it gets its own generous budget. */
@Injectable()
export class OllamaExtractionLlm implements ExtractionLlm {
  constructor(@Inject(LLM_FETCH) private readonly fetchFn: typeof fetch) {}

  async extractJson(
    system: string,
    user: string,
    schema: Record<string, unknown>,
  ): Promise<string> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.EXTRACT_MODEL ?? process.env.LLM_MODEL ?? 'qwen3:14b';
    const timeout = Number(process.env.EXTRACT_TIMEOUT_MS ?? 420_000);
    const res = await this.fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        think: true,
        format: schema,
        // long log + thinking blows past ollama's 4096 default ctx (silent truncation)
        options: { num_ctx: Number(process.env.EXTRACT_NUM_CTX ?? 8192) },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`ollama extract failed: HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const content = typeof data.message?.content === 'string' ? data.message.content : '';
    if (!content.trim()) throw new Error('ollama extract returned no content');
    return stripThink(content);
  }
}
