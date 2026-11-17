import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity, activityGroup } from "../../../../src/db/schema/activity.ts";
import { provider, userProfile } from "../../../../src/db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ClimbingVolumeRepository } from "./climbing-volume-repository.ts";

const timezone = "America/Los_Angeles";
const evaluationTime = new Date("2026-11-17T02:00:00Z");
const recordingProvider = "climbing-volume-recording";
const secondProvider = "climbing-volume-second-source";
const logProvider = "climbing-volume-logs";

describe("ClimbingVolumeRepository", () => {
  let context: TestContext;
  let userId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db
      .insert(provider)
      .values([recordingProvider, secondProvider, logProvider].map((id) => ({ id, name: id })));
  }, 60_000);

  beforeEach(async () => {
    userId = randomUUID();
    await context.db.insert(userProfile).values({ id: userId, name: "Climbing volume test" });
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  async function addActivity(
    startedAt: string,
    endedAt: string | null,
    overrides: Partial<typeof activity.$inferInsert> = {},
  ) {
    const owner = overrides.userId ?? userId;
    const groupId = overrides.groupId ?? randomUUID();
    await context.db
      .insert(activityGroup)
      .values({ id: groupId, userId: owner })
      .onConflictDoNothing();
    await context.db.insert(activity).values({
      userId: owner,
      groupId,
      externalId: randomUUID(),
      providerId: recordingProvider,
      canonicalType: "climbing",
      providerType: "climbing",
      startedAt: new Date(startedAt),
      endedAt: endedAt === null ? null : new Date(endedAt),
      ...overrides,
    });
    return groupId;
  }

  async function addBaseline() {
    // The first workout starts at midnight on the first baseline date, before DST ends.
    await addActivity("2026-10-13T07:00:00Z", "2026-10-13T13:00:00Z");
    // This workout crosses into the first recent date and belongs to the baseline by its start.
    await addActivity("2026-11-10T07:30:00Z", "2026-11-10T13:30:00Z");
  }

  function repository() {
    return new ClimbingVolumeRepository(context.db, userId, timezone);
  }

  const activeIncrease = {
    status: "increase",
    recentMinutes: 240,
    baselineMinutes: 180,
    increasePercent: expect.closeTo(100 / 3),
  };

  it("uses local start dates and counts only recorded climbing groups owned by the user", async () => {
    await addBaseline();
    const groupId = await addActivity("2026-11-16T19:00:00Z", "2026-11-16T23:00:00Z");
    await addActivity("2026-11-16T19:00:00Z", "2026-11-16T23:00:00Z", {
      groupId,
      providerId: secondProvider,
    });
    const log = { providerId: logProvider, providerType: "climbing_log" };
    await addActivity("2026-11-16T18:00:00Z", null, { ...log, groupId });
    await addActivity("2026-11-17T01:00:00Z", null, { ...log, groupId });
    const logOnlyGroupId = await addActivity("2026-11-12T18:00:00Z", null, log);
    await addActivity("2026-11-12T21:00:00Z", null, { ...log, groupId: logOnlyGroupId });
    await addActivity("2026-11-12T18:00:00Z", "2026-11-12T21:00:00Z", {
      groupId: logOnlyGroupId,
      providerAbsentAt: evaluationTime,
    });
    await addActivity("2026-10-13T06:59:59Z", "2026-10-13T17:00:00Z");
    await addActivity("2026-11-15T18:00:00Z", "2026-11-15T20:00:00Z", { canonicalType: "hiking" });
    await addActivity("2026-11-14T18:00:00Z", "2026-11-14T20:00:00Z", {
      canonicalType: "hangboard",
    });
    const otherUserId = randomUUID();
    await context.db.insert(userProfile).values({ id: otherUserId, name: "Another climber" });
    await addActivity("2026-11-12T19:00:00Z", "2026-11-12T23:00:00Z", { userId: otherUserId });

    expect(await repository().getIncrease(evaluationTime)).toEqual(activeIncrease);
  });

  it("updates after a workout completes and withholds a partially visible baseline", async () => {
    await addBaseline();
    await addActivity("2026-11-16T23:00:00Z", "2026-11-17T03:00:00Z");
    expect(await repository().getIncrease(evaluationTime)).toEqual({ status: "below_threshold" });
    const afterWorkout = new Date("2026-11-17T03:00:00Z");
    expect(await repository().getIncrease(afterWorkout)).toEqual(activeIncrease);

    const restricted = new ClimbingVolumeRepository(context.db, userId, timezone, {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-10-14",
      endDateExclusive: "2026-11-17",
    });
    expect(await restricted.getIncrease(afterWorkout)).toEqual({ status: "insufficient_data" });
  });

  it("withholds the comparison when a recorded workout has no end", async () => {
    await addBaseline();
    await addActivity("2026-11-16T19:00:00Z", "2026-11-16T23:00:00Z");
    await addActivity("2026-11-05T18:00:00Z", null);
    expect(await repository().getIncrease(evaluationTime)).toEqual({ status: "insufficient_data" });
  });
});
