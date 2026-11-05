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

it("erases one account's required frontiers while preserving another account and shared analytics progress", async () => {
  const context = await setupTestDatabase();
  try {
    const user = randomUUID(),
      other = randomUUID(),
      operation = randomUUID(),
      otherOperation = randomUUID();
    const run = randomUUID(),
      owner = randomUUID(),
      request = randomUUID();
    const position = JSON.stringify({
      transport: "kafka",
      epoch: "shared-analytics",
      topic: "metric-stream-live-v1",
      partition: 0,
      offset: "2",
    });
    const cursor = JSON.stringify({ delivery: { offset: "2" }, effectOrdinal: "0" });
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${user}::uuid,'Analytics erasure A'),(${other}::uuid,'Analytics erasure B')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_operation(id,user_id,kind,dataset_keys) VALUES(${operation}::uuid,${user}::uuid,'analytics_build',ARRAY['activity']),(${otherOperation}::uuid,${other}::uuid,'analytics_build',ARRAY['activity'])`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.analytics_run(id,owner_id,sealed) VALUES(${run}::uuid,${owner}::uuid,true)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.analytics_required_frontier(run_id,operation_id,user_id,dataset_key,transport,epoch,topic,partition,position) VALUES(${run}::uuid,${operation}::uuid,${user}::uuid,'activity','kafka','shared-analytics','metric-stream-live-v1',0,${position}::jsonb),(${run}::uuid,${otherOperation}::uuid,${other}::uuid,'activity','kafka','shared-analytics','metric-stream-live-v1',0,${position}::jsonb)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.analytics_stream_state(transport,epoch,topic,partition,owner_id,processed) VALUES('kafka','shared-analytics','metric-stream-live-v1',0,${owner}::uuid,${position}::jsonb)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.analytics_stage_cursor(run_id,stage,transport,epoch,topic,partition,cursor) VALUES(${run}::uuid,'scalar','kafka','shared-analytics','metric-stream-live-v1',0,${cursor}::jsonb)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.analytics_query_owner(resource_id,owner_id,quiescent,query_terminal) VALUES('shared-analytics',${owner}::uuid,true,true)`,
    );
    const sharedState = () =>
      executeWithSchema(
        context.db,
        z.object({ state: z.record(z.string(), z.unknown()) }),
        sql`SELECT jsonb_build_object(
        'run',(SELECT to_jsonb(r) FROM fitness.analytics_run r WHERE id=${run}::uuid),
        'stream',(SELECT to_jsonb(s) FROM fitness.analytics_stream_state s WHERE epoch='shared-analytics'),
        'cursor',(SELECT to_jsonb(c) FROM fitness.analytics_stage_cursor c WHERE run_id=${run}::uuid),
        'queryOwner',(SELECT to_jsonb(q) FROM fitness.analytics_query_owner q WHERE resource_id='shared-analytics')
      ) AS state`,
      );
    const before = await sharedState();
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request(id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,replay_retained_until,completion_deadline) VALUES(${request}::uuid,${user}::uuid,${"1".repeat(64)},'test-key',${"2".repeat(64)},${"3".repeat(64)},now()+interval '7 days',now()+interval '30 days')`,
    );
    await erasePostgresAccount(context.db, request, user);
    const frontiers = await executeWithSchema(
      context.db,
      z.object({ operation_id: z.uuid(), user_id: z.uuid() }),
      sql`SELECT operation_id,user_id FROM fitness.analytics_required_frontier WHERE run_id=${run}::uuid`,
    );
    expect(frontiers).toEqual([{ operation_id: otherOperation, user_id: other }]);
    expect(await sharedState()).toEqual(before);
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
  } finally {
    await context.cleanup();
  }
}, 120000);

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
