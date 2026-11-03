import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./execute-with-schema.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const migrationSql = readFileSync(
  new URL("../../drizzle/0176_remove_heart_rate_tss_parameters.sql", import.meta.url),
  "utf8",
);

describe("retired HR calibration settings cleanup", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it.each([
    {
      value: {
        version: 2,
        fittedAt: "2026-10-01T00:00:00Z",
        sleepTarget: { minutes: 480, sampleCount: 30 },
        successfulFitAt: {
          sleepTarget: "2026-10-01T00:00:00Z",
          trainingImpulseConstants: "2026-10-01T00:00:00Z",
        },
        trainingImpulseConstants: { genderFactor: 0.64, exponent: 1.92 },
      },
      expected: {
        version: 2,
        fittedAt: "2026-10-01T00:00:00Z",
        sleepTarget: { minutes: 480, sampleCount: 30 },
        successfulFitAt: { sleepTarget: "2026-10-01T00:00:00Z" },
      },
    },
    {
      value: { version: 1, sleepTarget: null, trainingImpulseConstants: null },
      expected: { version: 1, sleepTarget: null },
    },
    {
      value: { version: 2, successfulFitAt: { sleepTarget: null, trainingImpulseConstants: null } },
      expected: { version: 2, successfulFitAt: { sleepTarget: null } },
    },
    {
      value: { sleepTarget: null, successfulFitAt: null },
      expected: { sleepTarget: null, successfulFitAt: null },
    },
    { value: null, expected: null },
    { value: ["unchanged"], expected: ["unchanged"] },
  ])(
    "preserves supported settings and other setting keys for $value",
    async ({ value, expected }) => {
      const unrelated = { trainingImpulseConstants: "belongs to another setting" };
      await context.db.execute(
        sql`DELETE FROM fitness.user_settings WHERE user_id = ${TEST_USER_ID}`,
      );
      for (const [key, data] of [
        ["personalized_params", value],
        ["unrelated", unrelated],
      ] as const) {
        await context.db.execute(sql`INSERT INTO fitness.user_settings (user_id, key, value)
        VALUES (${TEST_USER_ID}, ${key}, ${JSON.stringify(data)}::jsonb)`);
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        await context.db.execute(sql.raw(migrationSql));
        const rows = await executeWithSchema(
          context.db,
          z.object({ key: z.string(), value: z.unknown() }),
          sql`SELECT key, value FROM fitness.user_settings
          WHERE user_id = ${TEST_USER_ID} ORDER BY key`,
        );
        expect(rows).toEqual([
          { key: "personalized_params", value: expected },
          { key: "unrelated", value: unrelated },
        ]);
      }
    },
  );
});
