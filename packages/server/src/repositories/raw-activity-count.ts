import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

const rawActivityCountRowSchema = z.object({
  raw_activity_count: z.coerce.number(),
});

export async function countRawActivities(
  db: Pick<Database, "execute">,
  input: {
    userId: string;
    days: number;
    activityTypes?: string[];
    requireEndedAt?: boolean;
    accessWindow?: AccessWindow;
  },
): Promise<number> {
  const activityTypePredicate =
    input.activityTypes && input.activityTypes.length > 0
      ? sql`AND activity_type IN (${sql.join(
          input.activityTypes.map((activityType) => sql`${activityType}`),
          sql`, `,
        )})`
      : sql``;
  const endedAtPredicate = input.requireEndedAt ? sql`AND ended_at IS NOT NULL` : sql``;
  const accessWindowPredicate =
    input.accessWindow?.kind === "limited"
      ? sql`AND started_at >= ${input.accessWindow.startDate}::timestamptz
            AND started_at < ${input.accessWindow.endDateExclusive}::timestamptz`
      : sql``;

  const rows = await executeWithSchema(
    db,
    rawActivityCountRowSchema,
    sql`SELECT count(*)::int AS raw_activity_count
        FROM fitness.activity
        WHERE user_id = ${input.userId}::uuid
          AND provider_absent_at IS NULL
          AND deleted_at IS NULL
          AND started_at > CURRENT_TIMESTAMP - ${input.days}::int * INTERVAL '1 day'
          ${endedAtPredicate}
          ${activityTypePredicate}
          ${accessWindowPredicate}`,
  );

  return rows[0]?.raw_activity_count ?? 0;
}
