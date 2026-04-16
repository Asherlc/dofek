import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { FoodEntryRepository } from "./food-entry-repository.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const DOFEK_PROVIDER_ID = "dofek";

describe("FoodEntryRepository - reproduction of 'already logged' issue", () => {
  let testCtx: TestContext;
  let repository: FoodEntryRepository;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    repository = new FoodEntryRepository(testCtx.db);

    // Ensure the dofek provider exists
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App', ${TEST_USER_ID})
          ON CONFLICT (id) DO NOTHING`,
    );
  }, 60_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  beforeEach(async () => {
    await testCtx.db.execute(sql`DELETE FROM fitness.food_entry WHERE user_id = ${TEST_USER_ID}`);
  });

  it("allows logging multiple identical food entries on the same day", async () => {
    const items = [
      {
        foodName: "Banana",
        foodDescription: "One medium banana",
        category: "fruit" as const,
        calories: 105,
        proteinG: 1.3,
        carbsG: 27,
        fatG: 0.4,
        fiberG: 3.1,
        saturatedFatG: 0.1,
        sugarG: 14,
        sodiumMg: 1,
        meal: "snack" as const,
      },
    ];

    // First entry
    const ids1 = await repository.saveUnconfirmed(TEST_USER_ID, "2026-04-15", items);
    expect(ids1).toHaveLength(1);

    // Second entry (identical)
    const ids2 = await repository.saveUnconfirmed(TEST_USER_ID, "2026-04-15", items);
    expect(ids2).toHaveLength(1);
    expect(ids2[0]).not.toBe(ids1[0]);

    // Verify both exist
    const rows = await testCtx.db.execute(
      sql`SELECT id FROM fitness.food_entry WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows).toHaveLength(2);
  });

  it("saveUnconfirmed returns IDs even when nutrition data is identical", async () => {
    const items = [
      {
        foodName: "Identical",
        foodDescription: "Identical",
        category: "other" as const,
        calories: 100,
        proteinG: 10,
        carbsG: 10,
        fatG: 10,
        fiberG: 0,
        saturatedFatG: 0,
        sugarG: 0,
        sodiumMg: 0,
        meal: "other" as const,
      },
    ];

    const ids1 = await repository.saveUnconfirmed(TEST_USER_ID, "2026-04-15", items);
    expect(ids1).toHaveLength(1);

    const ids2 = await repository.saveUnconfirmed(TEST_USER_ID, "2026-04-15", items);
    expect(ids2).toHaveLength(1);
    expect(ids2[0]).not.toBe(ids1[0]);
  });

  it("handles confirmation of entries correctly", async () => {
    const items = [
      {
        foodName: "Banana",
        foodDescription: "One medium banana",
        category: "fruit" as const,
        calories: 105,
        proteinG: 1.3,
        carbsG: 27,
        fatG: 0.4,
        fiberG: 3.1,
        saturatedFatG: 0.1,
        sugarG: 14,
        sodiumMg: 1,
        meal: "snack" as const,
      },
    ];

    const ids = await repository.saveUnconfirmed(TEST_USER_ID, "2026-04-15", items);
    
    // Confirm them
    const confirmedCount = await repository.confirm(ids);
    expect(confirmedCount).toBe(1);

    // Load summary
    const summary = await repository.loadConfirmedSummary(ids);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.food_name).toBe("Banana");

    // Try to confirm AGAIN
    const confirmedCount2 = await repository.confirm(ids);
    expect(confirmedCount2).toBe(0);

    // Load summary AGAIN (should still work)
    const summary2 = await repository.loadConfirmedSummary(ids);
    expect(summary2).toHaveLength(1);
  });
});
