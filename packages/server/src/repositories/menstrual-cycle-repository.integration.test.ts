import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleSchema as schema } from "../../../../src/db/drizzle-schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000c7";

describe("MenstrualCycleRepository with Postgres", () => {
  let context: TestContext;
  let sequence = 0;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db
      .insert(schema.userProfile)
      .values({ id: OTHER_USER_ID, name: "Other Cycle User" })
      .onConflictDoNothing();
    await ensureProvider(context.db, "apple_health", "Apple Health", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "garmin", "Garmin", undefined, TEST_USER_ID);
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  beforeEach(async () => {
    await context.db.delete(schema.healthEvent);
  });

  async function seedStart(
    timestamp: string,
    options: {
      userId?: string;
      providerId?: string;
      sourceName?: string | null;
      sourceBundle?: string | null;
      cycleStart?: boolean;
    } = {},
  ) {
    sequence += 1;
    await context.db.insert(schema.healthEvent).values({
      userId: options.userId ?? TEST_USER_ID,
      providerId: options.providerId ?? "apple_health",
      externalId: `cycle-integration-${sequence}`,
      type: "HKCategoryTypeIdentifierMenstrualFlow",
      value: 2,
      unit: "category",
      sourceName: options.sourceName ?? "Cycle Source",
      sourceBundle: options.sourceBundle ?? "com.example.cycle",
      metadata: { HKMetadataKeyMenstrualCycleStart: options.cycleStart ?? true },
      startDate: new Date(timestamp),
      endDate: new Date(timestamp),
    });
  }

  function repository(timezone = "UTC") {
    return new MenstrualCycleRepository(context.db, TEST_USER_ID, timezone);
  }

  it("groups exact local dates, preserves sources, and excludes non-start and other-user rows", async () => {
    await seedStart("2026-08-02T06:30:00Z", {
      sourceName: "Late Cycle Source",
      sourceBundle: "com.example.late-cycle",
    });
    await seedStart("2026-08-01T15:00:00Z", {
      providerId: "garmin",
      sourceName: "Garmin Connect",
      sourceBundle: null,
    });
    await seedStart("2026-08-03T12:00:00Z", { cycleStart: false });
    await seedStart("2026-08-01T12:00:00Z", { userId: OTHER_USER_ID });

    const history = await repository("America/Los_Angeles").getHistory(
      6,
      new Date("2026-08-14T12:00:00Z"),
    );

    expect(history).toEqual([
      {
        id: "cycle-start:2026-08-01",
        startDate: "2026-08-01",
        sources: [
          {
            providerId: "apple_health",
            sourceName: "Late Cycle Source",
            sourceBundle: "com.example.late-cycle",
          },
          {
            providerId: "garmin",
            sourceName: "Garmin Connect",
            sourceBundle: null,
          },
        ],
      },
    ]);
  });

  it("returns no history when no provider cycle starts exist", async () => {
    const result = await repository().getCurrentPhase(new Date("2026-08-14T12:00:00Z"));
    expect(result.availability.status).toBe("no-history");
  });

  it("estimates a phase from three completed regular intervals", async () => {
    for (const date of ["2026-05-13", "2026-06-10", "2026-07-08", "2026-08-05"]) {
      await seedStart(`${date}T12:00:00Z`);
    }

    const result = await repository().getCurrentPhase(new Date("2026-08-14T12:00:00Z"));
    expect(result).toMatchObject({
      phase: "follicular",
      dayOfCycle: 10,
      cycleLength: 28,
      availability: { status: "estimated" },
    });
  });

  it("returns sparse history for fewer than three completed intervals", async () => {
    for (const date of ["2026-06-01", "2026-06-29", "2026-07-27"]) {
      await seedStart(`${date}T12:00:00Z`);
    }
    const result = await repository().getCurrentPhase(new Date("2026-08-01T12:00:00Z"));
    expect(result.availability.status).toBe("sparse-history");
  });

  it("returns irregular history for out-of-range intervals", async () => {
    for (const date of ["2026-03-01", "2026-04-06", "2026-05-12", "2026-06-17"]) {
      await seedStart(`${date}T12:00:00Z`);
    }
    const result = await repository().getCurrentPhase(new Date("2026-06-20T12:00:00Z"));
    expect(result.availability.status).toBe("irregular-history");
  });

  it("returns conflicting history for distinct starts fewer than 21 days apart", async () => {
    await seedStart("2026-06-01T12:00:00Z");
    await seedStart("2026-06-20T12:00:00Z", { providerId: "garmin" });
    const result = await repository().getCurrentPhase(new Date("2026-06-25T12:00:00Z"));
    expect(result.availability.status).toBe("conflicting-history");
  });

  it("returns stale history beyond the average cycle plus seven days", async () => {
    for (const date of ["2026-03-01", "2026-03-29", "2026-04-26", "2026-05-24"]) {
      await seedStart(`${date}T12:00:00Z`);
    }
    const result = await repository().getCurrentPhase(new Date("2026-07-10T12:00:00Z"));
    expect(result.availability.status).toBe("stale-history");
  });

  it("does not expose another user's only record", async () => {
    await seedStart("2026-08-01T12:00:00Z", { userId: OTHER_USER_ID });
    const rows = await context.db
      .select()
      .from(schema.healthEvent)
      .where(eq(schema.healthEvent.userId, OTHER_USER_ID));
    expect(rows).toHaveLength(1);
    await expect(
      repository().getHistory(6, new Date("2026-08-14T12:00:00Z")),
    ).resolves.toEqual([]);
  });
});
