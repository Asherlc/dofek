import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { z } from "zod";
import { seedOwnedClimbingGraph } from "../db/climbing-lifecycle-test-helpers.ts";
import {
  climbGrade,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "../db/schema/climbing.ts";
import { setupTestDatabase } from "../db/test-helpers.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { assertPostgresAccountErasureCoverage, erasePostgresAccount } from "./postgres-erasure.ts";

it("covers and erases all climbing graph tables while fencing late pitch and grade writes", async () => {
  const context = await setupTestDatabase();
  try {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const requestId = randomUUID();
    const graph = await seedOwnedClimbingGraph(context.db, owner, "erase-climbing");
    const other = await seedOwnedClimbingGraph(context.db, otherOwner, "erase-climbing");
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request(id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,replay_retained_until,completion_deadline) VALUES(${requestId}::uuid,${owner}::uuid,${"1".repeat(64)},'test-key',${"2".repeat(64)},${"3".repeat(64)},now()+interval '7 days',now()+interval '30 days')`,
    );
    await expect(
      context.db.insert(pitch).values({ climbId: graph.climb, number: 2 }),
    ).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("Account erasure is active") },
    });
    await expect(
      context.db
        .insert(pitchGrade)
        .values({ pitchId: graph.pitch, position: 1, value: "A3", system: "aid" }),
    ).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("Account erasure is active") },
    });
    await expect(
      context.db
        .insert(climbGrade)
        .values({ climbId: graph.climb, position: 1, value: "5.11a", system: "yds" }),
    ).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("Account erasure is active") },
    });
    await expect(
      context.db
        .insert(climbingLogEntryGrade)
        .values({ climbingLogEntryId: graph.log, position: 1, value: "5.11b", system: "yds" }),
    ).rejects.toMatchObject({
      cause: { code: "55000", message: expect.stringContaining("Account erasure is active") },
    });
    await erasePostgresAccount(context.db, requestId, owner);
    const tables = [
      "area",
      "climb",
      "pitch",
      "climb_grade",
      "pitch_grade",
      "climbing_log_entry_grade",
      "climbing_log_entry",
      "climbing_attempt",
    ];
    for (const table of tables) {
      const [row] = await executeWithSchema(
        context.db,
        z.object({ count: z.coerce.number() }),
        sql`SELECT count(*) AS count FROM fitness.${sql.raw(table)}`,
      );
      expect(row?.count).toBe(table === "climbing_attempt" ? 2 : 1);
    }
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, other.log)),
    ).toHaveLength(1);
  } finally {
    await context.cleanup();
  }
}, 120000);
