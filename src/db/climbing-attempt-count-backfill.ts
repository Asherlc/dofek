import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { Database } from "./index.ts";

const countRowSchema = z.object({ count: z.number() });

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
    ? await executeWithSchema(
        db,
        countRowSchema,
        sql`
        WITH updated AS (
          UPDATE fitness.climbing_entry
          SET attempt_count = (raw->>'attempts')::int
          WHERE ${eligiblePredicate}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM updated
      `,
      )
    : await executeWithSchema(
        db,
        countRowSchema,
        sql`
        SELECT COUNT(*)::int AS count
        FROM fitness.climbing_entry
        WHERE ${eligiblePredicate}
      `,
      );

  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one backfill count row");
  }
  return row.count;
}
