import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

describe("CyclingThresholdRepository database semantics", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES ('threshold_history_test', 'Threshold History Test')
    `);
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns only exact-range cycling evidence with source kinds intact", async () => {
    await context.db.execute(sql`
      DELETE FROM fitness.provider_threshold_observation
      WHERE user_id = ${TEST_USER_ID}
        AND provider_id = 'threshold_history_test'
    `);
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
    await context.db.execute(sql`
      INSERT INTO fitness.provider_threshold_observation (
        user_id, provider_id, provider_record_id, sport, threshold_type,
        value, unit, observed_at, effective_at, raw
      ) VALUES
        (${TEST_USER_ID}, 'threshold_history_test', 'before', 'cycling', 'ftp',
          230, 'watt', '2026-04-30T23:59:59Z', NULL, '{"ftp":230}'),
        (${TEST_USER_ID}, 'threshold_history_test', 'profile', 'cycling', 'ftp',
          250, 'watt', '2026-07-01T12:00:00Z', NULL, '{"ftp":250}'),
        (${TEST_USER_ID}, 'threshold_history_test', 'modeled', 'cycling', 'modeled_ftp',
          258, 'watt', '2026-07-02T12:00:00Z', NULL, '{"zFtp":258}'),
        (${TEST_USER_ID}, 'threshold_history_test', 'run', 'running', 'ftp',
          320, 'watt', '2026-07-03T12:00:00Z', NULL, '{"ftp":320}')
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

    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => [item.value, item.value_kind])).toEqual([
      [258, "provider_estimated"],
      [250, "provider_recorded"],
      [245, "configured"],
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
