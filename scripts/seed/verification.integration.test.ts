import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../../src/db/test-helpers.ts";
import { seedBodyHealth } from "./body-health.ts";
import { seedCore } from "./core.ts";
import { SeedRandom, USER_ID } from "./helpers.ts";
import { seedRecovery } from "./recovery.ts";
import { seedReviewSurfaces } from "./review-surfaces.ts";
import { seedTraining } from "./training.ts";
import { verifySeed } from "./verification.ts";

let testContext: TestContext;
let sql: TaggedQueryClient;

beforeAll(async () => {
  testContext = await setupTestDatabase();
  sql = createTaggedQueryClient(testContext.connectionString);

  await seedCore(sql);
  const random = new SeedRandom(42);
  await seedRecovery(sql, random);
  await seedTraining(sql);
  await seedBodyHealth(sql);
  await seedReviewSurfaces(sql, random);
}, 120_000);

beforeEach(async () => {
  await sql`DELETE FROM fitness.food_entry WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql?.end();
  await testContext?.cleanup();
});

describe("review seed verification", () => {
  it("rejects many food rows on fewer than 85 canonical dates", async () => {
    await insertFoodEntries({ distinctDates: 84, totalEntries: 85 });

    await expect(verifySeed(sql)).rejects.toThrow(
      "Seed verification failed for nutrition days: expected at least 85, got 84",
    );
  });

  it("accepts exactly 85 nutrition dates and still reports total food entries", async () => {
    await insertFoodEntries({ distinctDates: 85, totalEntries: 85 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(verifySeed(sql)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("  nutrition days: 85");
      expect(logSpy).toHaveBeenCalledWith("  food entries: 85");
    } finally {
      logSpy.mockRestore();
    }
  });
});

async function insertFoodEntries({
  distinctDates,
  totalEntries,
}: {
  distinctDates: number;
  totalEntries: number;
}): Promise<void> {
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex++) {
    const dateIndex = entryIndex < distinctDates ? entryIndex : 0;
    const date = dateForIndex(dateIndex);
    const loggedAt =
      entryIndex === 0
        ? "2026-01-01T23:30:00.000Z"
        : entryIndex === distinctDates
          ? "2026-01-02T08:30:00.000Z"
          : `${date}T12:00:00.000Z`;

    await sql`
      INSERT INTO fitness.food_entry (
        provider_id,
        user_id,
        external_id,
        date,
        food_name,
        logged_at,
        confirmed
      ) VALUES (
        'manual_review',
        ${USER_ID},
        ${`review-verification-${entryIndex}`},
        ${date},
        'Review verification fixture',
        ${loggedAt},
        true
      )
    `;
  }
}

function dateForIndex(dateIndex: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + dateIndex));
  return date.toISOString().slice(0, 10);
}
