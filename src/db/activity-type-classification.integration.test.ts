import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./execute-with-schema.ts";
import { activity } from "./schema/activity.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

const storedActivityTypeSchema = z.object({
  canonicalType: z.string(),
  modality: z.string().nullable(),
  providerType: z.string(),
});

const activityColumnSchema = z.object({
  columnName: z.string(),
});

const canonicalActivityRowSchema = z.object({
  canonicalType: z.string(),
  providerType: z.string(),
});

describe("canonical activity type storage", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "canonical-type-a", "Canonical Type A");
    await ensureProvider(context.db, "canonical-type-b", "Canonical Type B");
  }, 120_000);

  afterAll(async () => {
    if (context) await context.cleanup();
  });

  it("stores canonical type, verbatim provider type, and modality without the legacy column", async () => {
    const startedAt = new Date("2026-07-20T12:00:00.000Z");
    const endedAt = new Date("2026-07-20T13:00:00.000Z");

    await context.db.insert(activity).values([
      {
        providerId: "canonical-type-a",
        externalId: "climbing-a",
        canonicalType: "climbing",
        providerType: "climbing",
        modality: null,
        startedAt,
        endedAt,
      },
      {
        providerId: "canonical-type-b",
        externalId: "climbing-b",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        modality: null,
        startedAt,
        endedAt,
      },
    ]);

    const storedRows = await executeWithSchema(
      context.db,
      storedActivityTypeSchema,
      sql`SELECT
            canonical_type AS "canonicalType",
            provider_type AS "providerType",
            modality
          FROM fitness.activity
          WHERE provider_id IN ('canonical-type-a', 'canonical-type-b')
          ORDER BY provider_id`,
    );
    expect(storedRows).toEqual([
      {
        canonicalType: "climbing",
        providerType: "climbing",
        modality: null,
      },
      {
        canonicalType: "climbing",
        providerType: "rock_climbing",
        modality: null,
      },
    ]);

    const columns = await executeWithSchema(
      context.db,
      activityColumnSchema,
      sql`SELECT column_name AS "columnName"
          FROM information_schema.columns
          WHERE table_schema = 'fitness'
            AND table_name = 'activity'
            AND column_name IN ('activity_type', 'canonical_type', 'provider_type', 'modality')
          ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { columnName: "canonical_type" },
      { columnName: "modality" },
      { columnName: "provider_type" },
    ]);

    const canonicalRows = await executeWithSchema(
      context.db,
      canonicalActivityRowSchema,
      sql`SELECT
            canonical_type AS "canonicalType",
            provider_type AS "providerType"
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND started_at = ${startedAt}
            AND canonical_type = 'climbing'`,
    );
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0]?.canonicalType).toBe("climbing");
    expect(["climbing", "rock_climbing"]).toContain(canonicalRows[0]?.providerType);
  });
});
