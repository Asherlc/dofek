import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import type { Database } from "../../../../src/db/index.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

export async function climbingTestDate(db: Database, daysAgo = 2, timezone = "UTC") {
  const [row] = await executeWithSchema(
    db,
    z.object({ date: z.string() }),
    sql`
    SELECT ((NOW() AT TIME ZONE ${timezone})::date - ${daysAgo}::int)::text AS date`,
  );
  if (!row) throw new Error("Expected test calendar date");
  return row.date;
}

export async function seedClimbingActivity(
  db: Database,
  providerId: string,
  externalId: string,
  startedAt = new Date(Date.now() - 2 * 86400000),
) {
  const [row] = await db
    .insert(activity)
    .values({
      userId: TEST_USER_ID,
      providerId,
      externalId,
      canonicalType: "climbing",
      providerType: "climbing",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 3600000),
      name: "Climbing",
    })
    .returning();
  if (!row?.groupId) throw new Error("Expected test activity group");
  return row;
}

export async function seedClimbingLog(
  db: Database,
  providerId: string,
  source: SourceClimbingLogEntry,
) {
  const result = await persistClimbingLogEntries(db, {
    userId: TEST_USER_ID,
    providerId,
    entries: [source],
  });
  const id = result.logEntryIds[0];
  if (!id) throw new Error("Expected test climbing log");
  return id;
}
