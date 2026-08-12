import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

describe("hangboard activity type migration", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("applies the migration and exposes hangboard in the Postgres enum", async () => {
    const result = await executeWithSchema(
      context.db,
      z.object({ enumlabel: z.string() }),
      sql`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
      WHERE pg_namespace.nspname = 'fitness'
        AND pg_type.typname = 'canonical_activity_type'
      ORDER BY enumsortorder
    `,
    );

    const labels = result.map((row) => row.enumlabel);
    const climbingIndex = labels.indexOf("climbing");

    expect(labels).toContain("hangboard");
    expect(labels[climbingIndex + 1]).toBe("hangboard");
  });
});
