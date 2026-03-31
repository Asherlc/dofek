import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const sessionRowSchema = z.object({
  id: z.string(),
  technique_id: z.string(),
  rounds: z.coerce.number(),
  duration_seconds: z.coerce.number(),
  started_at: timestampStringSchema,
  notes: z.string().nullable(),
});

type SessionRow = z.infer<typeof sessionRowSchema>;

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export class BreathworkSession {
  readonly #row: SessionRow;

  constructor(row: SessionRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      id: this.#row.id,
      techniqueId: this.#row.technique_id,
      rounds: Number(this.#row.rounds),
      durationSeconds: Number(this.#row.duration_seconds),
      startedAt: this.#row.started_at,
      notes: this.#row.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for breathwork sessions. */
export class BreathworkRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async logSession(input: {
    techniqueId: string;
    rounds: number;
    durationSeconds: number;
    startedAt: string;
    notes: string | null;
  }): Promise<BreathworkSession | null> {
    const rows = await executeWithSchema(
      this.#db,
      sessionRowSchema,
      sql`INSERT INTO fitness.breathwork_session (user_id, technique_id, rounds, duration_seconds, started_at, notes)
          VALUES (${this.#userId}, ${input.techniqueId}, ${input.rounds}, ${input.durationSeconds}, ${input.startedAt}::timestamptz, ${input.notes})
          RETURNING id, technique_id, rounds, duration_seconds, started_at, notes`,
    );

    const row = rows[0];
    return row ? new BreathworkSession(row) : null;
  }

  async getHistory(days: number): Promise<BreathworkSession[]> {
    const rows = await executeWithSchema(
      this.#db,
      sessionRowSchema,
      sql`SELECT id, technique_id, rounds, duration_seconds, started_at, notes
          FROM fitness.breathwork_session
          WHERE user_id = ${this.#userId}
            AND started_at >= NOW() - (${days}::int || ' days')::interval
          ORDER BY started_at DESC`,
    );

    return rows.map((row) => new BreathworkSession(row));
  }
}
