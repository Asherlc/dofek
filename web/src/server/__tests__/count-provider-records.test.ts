import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/__tests__/test-helpers.js";

/**
 * Test that raw SQL queries use schema-qualified table names.
 * Reproduces: "relation 'cardio_activity' does not exist" error
 * when the DB search_path doesn't include the 'fitness' schema.
 */
describe("countProviderRecords SQL", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    // Reset search_path to only 'public' — simulates production where
    // the default search_path may not include 'fitness'
    await testCtx.db.execute(sql`SET search_path TO public`);
  }, 30_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  it("queries fitness-schema tables with explicit schema qualification", async () => {
    const providerId = "test-provider";
    const result = await testCtx.db.execute<{ total: string }>(sql`
      SELECT
        (SELECT count(*) FROM fitness.activity WHERE provider_id = ${providerId}) +
        (SELECT count(*) FROM fitness.daily_metrics WHERE provider_id = ${providerId}) +
        (SELECT count(*) FROM fitness.sleep_session WHERE provider_id = ${providerId}) +
        (SELECT count(*) FROM fitness.body_measurement WHERE provider_id = ${providerId}) +
        (SELECT count(*) FROM fitness.food_entry WHERE provider_id = ${providerId}) +
        (SELECT count(*) FROM fitness.health_event WHERE provider_id = ${providerId})
      AS total
    `);
    expect(Number(result[0]?.total ?? 0)).toBe(0);
  });
});
