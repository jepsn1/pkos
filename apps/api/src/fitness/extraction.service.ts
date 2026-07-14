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

/** JSON Schema handed to ollama's `format` — constrained decoding guarantees shape. */
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['exercises', 'general_notes'],
  properties: {
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        required: ['exercise', 'sets', 'note'],
        properties: {
          exercise: { type: 'string' },
          sets: {
            type: 'array',
            items: {
              type: 'object',
              required: ['reps', 'weight_kg'],
              properties: {
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

Rules:
- Keep the user's own exercise names verbatim (any language), lowercased. Never translate or rename.
- "AxB" means A sets of B reps: "3x8" = 3 sets of 8 reps ("bench 5x5 80kg" = five sets of {reps: 5, weight_kg: 80}).
- Set counts are realistically 2-6 and reps 5-25. When AxB is ambiguous ("12x3", "15x3", "14x3"), the number in the 2-6 range is the SET count and the other is the reps: "12x3" = 3 sets of 12 reps, NEVER 12 sets of 3. Only read AxB as reps-first like this when A is outside 2-6 and B is inside it.
- Comma decimals are European: "10,5kg" = 10.5 kg, "124,6" = 124.6, "15,8kg" = 15.8.
- A weight followed by a comma-separated rep list is one set per rep: "28kg, 12,10,9" = 3 sets at 28 kg with reps 12, 10, 9 (descending rep lists are normal). "86kg 12,7" = 2 sets at 86 kg (12 reps, 7 reps).
- A line/segment with ONLY numbers — weight and/or reps but NO exercise name (e.g. "73kg 3x10", "13,5kg 8,10,10") — CONTINUES the PREVIOUS exercise: append its sets to that same exercise (a different weight on the same movement). NEVER invent an exercise named after a weight like "73kg" or "13,5kg".
- No weight given (e.g. "pull-ups 3x13") → weight_kg null (bodyweight).
- Machine/equipment settings ("Seat 5, chest 3"), form remarks ("ny form", "bedre form", "perfect form", "perfekt form"), and questions ("op?", "increase?") are NEVER sets and NEVER exercises: put them in the note of the exercise they follow, or in general_notes if they follow nothing.
- An exercise name with NO numbers at all (e.g. a bare "sitting row" header) gets sets: [] and a mention in general_notes — do not invent sets for it.
- Weights are kg. Every exercise the user actually performed with numbers must appear, with EVERY set (a "3xN" entry always yields exactly 3 set objects).`;

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

interface ParsedSet {
  reps?: unknown;
  weight_kg?: unknown;
}
interface ParsedExercise {
  exercise?: unknown;
  sets?: unknown;
  note?: unknown;
}

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
      for (const rawSet of (Array.isArray(raw.sets) ? raw.sets : []) as ParsedSet[]) {
        const reps = rawSet?.reps;
        if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) {
          skipped.push(`${name}: set dropped (reps ${JSON.stringify(reps)} out of 1-${MAX_REPS})`);
          continue;
        }
        let weight = rawSet.weight_kg ?? null;
        if (weight === 0) weight = null; // 0 kg = bodyweight
        if (
          weight !== null &&
          (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT_KG)
        ) {
          skipped.push(
            `${name}: set dropped (weight ${JSON.stringify(weight)} out of 0-${MAX_WEIGHT_KG} kg)`,
          );
          continue;
        }
        sets.push({ reps, weightKg: weight as number | null });
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
