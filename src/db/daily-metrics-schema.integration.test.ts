import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("daily metrics schema", () => {
  it("does not expose stored resting HR or VO2 Max columns", async () => {
    const columns = await ctx.db.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'fitness'
        AND table_name = 'daily_metrics'
      ORDER BY column_name
    `);

    const columnNames = columns.map((row) => row.column_name);
    expect(columnNames).not.toContain("resting_hr");
    expect(columnNames).not.toContain("vo2max");
  });
});
