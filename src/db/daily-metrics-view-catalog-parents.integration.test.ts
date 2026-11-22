import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";
import { executeWithSchema } from "./typed-sql.ts";

describe("fitness.v_daily_metrics catalog-only parents", () => {
  let context: TestContext;
  const userId = randomUUID();

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'View Parents')`,
    );
    await ensureProvider(context.db, "apple_health", "Apple Health", "https://example.test");
    await ensureProvider(context.db, "intervals.icu", "Intervals.icu", "https://intervals.icu");
    // 2026-03-01: native steps plus a catalog-only parent. 2026-03-02: a catalog-only parent alone.
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, steps) VALUES
            ('2026-03-01', 'apple_health', ${userId}::uuid, 4000),
            ('2026-03-01', 'intervals.icu', ${userId}::uuid, NULL),
            ('2026-03-02', 'intervals.icu', ${userId}::uuid, NULL)`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("resolves walking steadiness by recovery priority, as deployed", async () => {
    const priorityUser = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${priorityUser}::uuid, 'View Steadiness')`,
    );
    await ensureProvider(context.db, "garmin", "Garmin", "https://example.test");
    await ensureProvider(context.db, "whoop", "WHOOP", "https://example.test");
    await context.db.execute(sql`
      INSERT INTO fitness.provider_priority (provider_id, priority, recovery_priority)
      VALUES ('garmin', 0, 10), ('whoop', 10, 0)
      ON CONFLICT (provider_id) DO UPDATE
        SET priority = excluded.priority, recovery_priority = excluded.recovery_priority`);
    await context.db.execute(sql`
      INSERT INTO fitness.daily_metrics (date, provider_id, user_id, walking_steadiness)
      VALUES ('2026-04-01', 'garmin', ${priorityUser}::uuid, 0.25),
             ('2026-04-01', 'whoop', ${priorityUser}::uuid, 0.75)`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ walking_steadiness: z.number().nullable() }),
      sql`SELECT walking_steadiness FROM fitness.v_daily_metrics WHERE user_id = ${priorityUser}::uuid`,
    );
    expect(rows).toEqual([{ walking_steadiness: 0.75 }]);
  });

  it("keeps catalog-only parents out of dates and source providers", async () => {
    const rows = await executeWithSchema(
      context.db,
      z.object({
        date: z.string(),
        steps: z.number().nullable(),
        source_providers: z.array(z.string()),
      }),
      sql`SELECT date::text AS date, steps, source_providers
          FROM fitness.v_daily_metrics WHERE user_id = ${userId}::uuid ORDER BY date`,
    );
    expect(rows).toEqual([{ date: "2026-03-01", steps: 4000, source_providers: ["apple_health"] }]);
  });
});
