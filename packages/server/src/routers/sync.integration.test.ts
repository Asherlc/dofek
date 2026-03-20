import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

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
  });

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

describe("triggerSync token lookup SQL", () => {
  let testCtx: TestContext;
  const testUserId = "00000000-0000-0000-0000-000000000099";

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await testCtx.db.execute(sql`SET search_path TO public`);

    // Seed a user, two providers, and one oauth token
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${testUserId}, 'Test User')`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('strava', 'Strava', ${testUserId})`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('wahoo', 'Wahoo', ${testUserId})`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.oauth_token (provider_id, access_token) VALUES ('strava', 'tok')`,
    );
  });

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  const tokenRowSchema = z.object({ provider_id: z.string() });

  it("returns only providers that have oauth tokens for the given user", async () => {
    const rows = await executeWithSchema(
      testCtx.db,
      tokenRowSchema,
      sql`SELECT DISTINCT ot.provider_id
          FROM fitness.oauth_token ot
          JOIN fitness.provider p ON p.id = ot.provider_id
          WHERE p.user_id = ${testUserId}`,
    );
    expect(rows).toEqual([{ provider_id: "strava" }]);
  });

  it("returns empty when user has no tokens", async () => {
    const otherUserId = "00000000-0000-0000-0000-000000000098";
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUserId}, 'Other')`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('polar', 'Polar', ${otherUserId})`,
    );

    const rows = await executeWithSchema(
      testCtx.db,
      tokenRowSchema,
      sql`SELECT DISTINCT ot.provider_id
          FROM fitness.oauth_token ot
          JOIN fitness.provider p ON p.id = ot.provider_id
          WHERE p.user_id = ${otherUserId}`,
    );
    expect(rows).toEqual([]);
  });
});
