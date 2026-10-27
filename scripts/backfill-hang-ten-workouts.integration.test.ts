import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import { backfillHangTenWorkouts } from "./backfill-hang-ten-workouts.ts";

const userId = "10000000-0000-4000-8000-000000002503";

describe("Hang Ten workout backfill (integration)", () => {
  let context: TestContext;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    context = await setupTestDatabase();
    process.env.DATABASE_URL = context.connectionString;

    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Hang Ten backfill user')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${userId}::uuid)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.activity (
            id,
            provider_id,
            user_id,
            external_id,
            canonical_type,
            provider_type,
            started_at,
            ended_at,
            raw
          )
          VALUES
            (
              '20000000-0000-4000-8000-000000002503'::uuid,
              'apple_health',
              ${userId}::uuid,
              'hang-ten-valid',
              'strength',
              'functional_strength',
              '2025-06-06T06:00:00Z',
              '2025-06-06T06:00:10Z',
              ${JSON.stringify({
                metadata: {
                  HKMetadataKeyWorkoutBrandName: "Hang Ten",
                  "HangTen.PlanName": "Morning session",
                },
              })}::jsonb
            ),
            (
              '20000000-0000-4000-8000-000000002504'::uuid,
              'apple_health',
              ${userId}::uuid,
              'hang-ten-numeric-plan',
              'strength',
              'functional_strength',
              '2025-06-07T06:00:00Z',
              '2025-06-07T06:00:10Z',
              ${JSON.stringify({
                metadata: {
                  HKMetadataKeyWorkoutBrandName: "Hang Ten",
                  "HangTen.PlanName": 42,
                },
              })}::jsonb
            ),
            (
              '20000000-0000-4000-8000-000000002505'::uuid,
              'apple_health',
              ${userId}::uuid,
              'hang-ten-whitespace-plan',
              'strength',
              'functional_strength',
              '2025-06-08T06:00:00Z',
              '2025-06-08T06:00:10Z',
              ${JSON.stringify({
                metadata: {
                  HKMetadataKeyWorkoutBrandName: "Hang Ten",
                  "HangTen.PlanName": " \t ",
                },
              })}::jsonb
            )`,
    );
  }, 120_000);

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await context?.cleanup();
  });

  it("selects only Hang Ten workouts with a nonblank text plan name", async () => {
    await expect(backfillHangTenWorkouts(false)).resolves.toBe(1);
  });
});
