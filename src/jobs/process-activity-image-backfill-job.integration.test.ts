import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  dispatchActivityImageBackfills,
  getActivityImageBackfillProgress,
  processActivityImageBackfillJob,
  startActivityImageBackfill,
} from "./process-activity-image-backfill-job.ts";

describe("historical activity image checkpoints", () => {
  let ctx: TestContext;
  const userId = randomUUID();
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Historical images')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('media-backfill-test','Historical image test') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection(user_id,provider_id) VALUES(${userId},'media-backfill-test')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(user_id,provider_id,external_id,canonical_type,provider_type,started_at) SELECT ${userId}::uuid,'media-backfill-test',position::text,'cycling','Ride','2020-01-01'::timestamptz FROM generate_series(1,103) position`,
    );
  }, 120000);
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("resumes timestamp ties past the first page and records unavailable coverage honestly", async () => {
    const [runId] = await startActivityImageBackfill(ctx.db, userId, "media-backfill-test");
    if (!runId) throw Error("No run created");
    const queue = { add: async () => ({}) };
    await dispatchActivityImageBackfills(ctx.db, queue);
    await processActivityImageBackfillJob(ctx.db, { userId, backfillId: runId });
    expect((await getActivityImageBackfillProgress(ctx.db, userId, runId))[0]).toMatchObject({
      scanned: 100,
      state: "pending",
    });
    await dispatchActivityImageBackfills(ctx.db, queue);
    await processActivityImageBackfillJob(ctx.db, { userId, backfillId: runId });
    expect((await getActivityImageBackfillProgress(ctx.db, userId, runId))[0]).toMatchObject({
      scanned: 103,
      state: "completed",
      coverage: { unavailable: 103 },
    });
    await processActivityImageBackfillJob(ctx.db, { userId, backfillId: runId });
    expect((await getActivityImageBackfillProgress(ctx.db, userId, runId))[0]?.scanned).toBe(103);
  });
});
