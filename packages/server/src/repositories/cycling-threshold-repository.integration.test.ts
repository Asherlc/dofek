import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

describe("CyclingThresholdRepository database semantics", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns only exact-range cycling evidence with source kinds intact", async () => {
    await context.db.execute(sql`
      DELETE FROM fitness.sport_settings
      WHERE user_id = ${TEST_USER_ID}
        AND sport IN ('cycling', 'running')
    `);
    await context.db.execute(sql`
      UPDATE fitness.user_profile SET ftp = 235 WHERE id = ${TEST_USER_ID}
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.sport_settings (user_id, sport, ftp, effective_from)
      VALUES
        (${TEST_USER_ID}, 'cycling', 240, '2026-05-01'),
        (${TEST_USER_ID}, 'cycling', 245, '2026-06-01'),
        (${TEST_USER_ID}, 'running', 300, '2026-06-15')
    `);
    const result = await new CyclingThresholdRepository(
      context.db,
      TEST_USER_ID,
      "America/Los_Angeles",
    ).listHistory({
      startDate: "2026-05-15",
      endDate: "2026-07-31",
      providers: [],
      cursor: null,
      limit: 10,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => [item.value, item.value_kind])).toEqual([
      [245, "configured"],
      [240, "configured"],
    ]);
    expect(result.legacy_current).toMatchObject({
      value: 235,
      historical_validity: "unknown",
    });
    expect(result.next_cursor).toBeNull();

    await expect(
      new CyclingThresholdRepository(
        context.db,
        TEST_USER_ID,
        "America/Los_Angeles",
      ).getApplicableConfiguredFtp("2026-07-31"),
    ).resolves.toMatchObject({
      value: 245,
      value_kind: "configured",
      historical_validity: "effective_dated",
    });
  });
});
