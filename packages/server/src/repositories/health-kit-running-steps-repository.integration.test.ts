import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../../../../src/db/schema/activity.ts";
import { userProfile } from "../../../../src/db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import {
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamEventV2,
} from "../../../../src/metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import type { RunningStepSample, WorkoutSample } from "../routers/health-kit-sync-schemas.ts";
import { processRunningStepSamples } from "./health-kit-running-steps-repository.ts";
import { HealthKitSyncRepository } from "./health-kit-sync-repository.ts";

const userId = "00000000-0000-0000-0000-000000000001";
describe("associated running steps", () => {
  let ctx: TestContext;
  const events: MetricStreamEventV2[] = [];
  const deletedScopes: unknown[] = [];
  const publisher: MetricStreamEventPublisher = {
    publishRows: async (rows, options) => {
      const batch = rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
      events.push(...batch);
      return batch;
    },
    replaceRows: async (scope, rows, revision) => {
      deletedScopes.push(scope);
      return {
        deleted: createMetricStreamDeletedEvent(scope, revision),
        rows: rows.map((row) => createMetricStreamEvent(row, revision)),
      };
    },
  };
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "apple_health", "Apple Health", undefined, userId);
  }, 60000);
  afterAll(async () => {
    await ctx?.cleanup();
  });
  function workout(uuid = randomUUID()): WorkoutSample {
    return {
      uuid,
      workoutType: "37",
      startDate: "2026-10-20T10:00:00Z",
      endDate: "2026-10-20T11:00:00Z",
      duration: 3600,
      totalDistance: null,
      sourceName: "Watch",
      sourceBundle: "watch",
    };
  }
  function sample(run: WorkoutSample): RunningStepSample {
    return {
      type: "HKQuantityTypeIdentifierStepCount",
      uuid: randomUUID(),
      value: 3.5,
      unit: "count",
      startDate: "2026-10-20T10:00:00.125Z",
      endDate: "2026-10-20T10:00:01.375Z",
      sourceName: "Watch",
      sourceBundle: "watch",
      workoutUuids: [run.uuid],
    };
  }
  async function stored(run: WorkoutSample, owner = userId) {
    return (
      await ctx.db
        .select()
        .from(activity)
        .where(and(eq(activity.userId, owner), eq(activity.externalId, `hk:workout:${run.uuid}`)))
    )[0];
  }
  it("adds workout contexts without hiding absent list members and restores confirmed presence only", async () => {
    const existing = workout();
    const run = workout();
    await processRunningStepSamples(ctx.db, userId, [existing, run], [sample(run)], publisher);
    const runRow = await stored(run);
    if (!runRow) throw new Error("Workout missing");
    await ctx.db
      .update(activity)
      .set({ providerAbsentAt: new Date(), absenceProviderId: "apple_health" })
      .where(eq(activity.id, runRow.id));
    const observation = sample(run);
    await processRunningStepSamples(ctx.db, userId, [run], [observation], publisher);
    expect((await stored(run))?.providerAbsentAt).toBeNull();
    expect((await stored(existing))?.providerAbsentAt).toBeNull();
    const deletion = new Date("2026-10-21T00:00:00Z");
    await ctx.db.update(activity).set({ deletedAt: deletion }).where(eq(activity.id, runRow.id));
    await processRunningStepSamples(ctx.db, userId, [run], [observation], publisher);
    expect((await stored(run))?.deletedAt).toEqual(deletion);
    expect(events.at(-1)).toMatchObject({
      userId,
      channel: "step_count",
      scalar: 3.5,
      externalId: `hk:${observation.uuid}`,
      metadata: {
        interval_end: observation.endDate,
        source_bundle: "watch",
        workout_uuids: [run.uuid],
      },
    });
  });
  it("keeps another user's source identity untouched and rejects an association without owned upload context", async () => {
    const otherId = randomUUID();
    await ctx.db.insert(userProfile).values({ id: otherId, name: "Other" });
    const run = workout();
    await processRunningStepSamples(ctx.db, otherId, [run], [sample(run)], publisher);
    const foreign = await stored(run, otherId);
    await expect(
      processRunningStepSamples(ctx.db, userId, [], [sample(run)], publisher),
    ).rejects.toThrow(/outside this upload/i);
    expect(await stored(run)).toBeUndefined();
    expect((await stored(run, otherId))?.id).toBe(foreign?.id);
  });
  it("parent deletion scopes only raw step children for the authenticated user", async () => {
    const run = workout();
    const observation = sample(run);
    await processRunningStepSamples(ctx.db, userId, [run], [observation], publisher);
    await new HealthKitSyncRepository(ctx.db, userId, publisher).processDeletedQuantitySamples(
      observation.type,
      [observation.uuid],
    );
    expect(deletedScopes.at(-1)).toEqual({
      userId,
      providerId: "apple_health",
      externalId: `hk:${observation.uuid}`,
      channel: "step_count",
    });
  });
});
