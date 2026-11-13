import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleSchema as schema } from "../../../../src/db/drizzle-schema.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { upsertWorkoutBatch } from "../../../../src/providers/apple-health/db-insertion.ts";
import { hangTenContactMetadata } from "../../../../src/providers/apple-health/test-helpers.ts";
import { parseWorkout } from "../../../../src/providers/apple-health/workouts.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { HangboardingRepository } from "./hangboarding-repository.ts";

describe("Hang Ten contact workout import", () => {
  const client = createClickHouseClientFromEnv();
  const sensorStore = new ClickHouseActivitySensorStore(client);
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.insert(schema.provider).values({ id: "apple_health", name: "Apple Health" });
  }, 60_000);

  afterAll(async () => {
    await client.close?.();
    await context?.cleanup();
  });

  it("serves 18 completed hangs after importing and reimporting a contact-based session", async () => {
    const workout = parseWorkout(
      {
        sourceName: "Hang Ten",
        workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
        startDate: "2026-10-20T15:51:31Z",
        endDate: "2026-10-20T16:00:42Z",
        duration: "551",
        durationUnit: "s",
      },
      hangTenContactMetadata(),
    );

    await upsertWorkoutBatch(context.db, "apple_health", [workout]);
    await upsertWorkoutBatch(context.db, "apple_health", [workout]);

    const [stored] = await context.db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.externalId, "ah:workout:66666666-6666-4666-8666-666666666666"));
    if (!stored) throw new Error("Expected the imported Hang Ten workout");
    const intervals = await context.db
      .select()
      .from(schema.activityInterval)
      .where(eq(schema.activityInterval.activityId, stored.id));
    expect(intervals).toHaveLength(39);
    expect(intervals[0]?.raw).toMatchObject({
      target: { kind: "resolvedContacts" },
      handUse: "double",
      side: "both",
    });

    const detail = await new HangboardingRepository(
      context.db,
      TEST_USER_ID,
      "America/Los_Angeles",
      sensorStore,
    ).getDetail(stored.groupId);
    expect(detail).toMatchObject({
      planName: "Rehab",
      boardName: "Grindstone Mk2",
      segmentsError: null,
      summary: {
        workIntervalCount: 18,
        totalWorkDurationSeconds: 126,
        exercises: [{ label: "25 mm edge", workIntervalCount: 18, workDurationSeconds: 126 }],
      },
    });
    expect(detail?.summary.totalRestDurationSeconds).toBeCloseTo(421.341, 3);
  });
});
