import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./index.ts";

const countRowSchema = z.tuple([z.object({ count: z.number() })]);

export async function backfillClimbingAttemptCount(
  db: Pick<Database, "execute">,
  execute: boolean,
): Promise<number> {
  const eligiblePredicate = sql`
    source_name = 'Kaya'
    AND jsonb_typeof(raw->'attempts') = 'number'
    AND raw->>'attempts' ~ '^[1-9][0-9]*$'
    AND (raw->>'attempts')::numeric <= 2147483647
    AND attempt_count <> (raw->>'attempts')::int
  `;

  const rows = execute
    ? await db.execute(sql`
        WITH updated AS (
          UPDATE fitness.climbing_entry
          SET attempt_count = (raw->>'attempts')::int
          WHERE ${eligiblePredicate}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM updated
      `)
    : await db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM fitness.climbing_entry
        WHERE ${eligiblePredicate}
      `);

  return countRowSchema.parse(rows)[0].count;
}
