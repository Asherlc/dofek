import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordProviderThresholdObservation } from "./provider-threshold-observation.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("provider threshold observations", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES ('threshold_test', 'Threshold Test')
    `);
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("stores only value transitions while preserving immutable source evidence", async () => {
    await context.db.execute(sql`
      DELETE FROM fitness.provider_threshold_observation
      WHERE user_id = ${TEST_USER_ID}
        AND provider_id = 'threshold_test'
    `);
    const base = {
      userId: TEST_USER_ID,
      providerId: "threshold_test",
      providerRecordId: "profile:rider-1",
      sport: "cycling",
      thresholdType: "ftp",
      unit: "watt",
      effectiveAt: null,
    } as const;

    await expect(
      recordProviderThresholdObservation(context.db, {
        ...base,
        value: 250,
        observedAt: new Date("2026-08-01T12:00:00Z"),
        raw: { ftp: 250, source: "profile" },
      }),
    ).resolves.toBe(true);
    await expect(
      recordProviderThresholdObservation(context.db, {
        ...base,
        value: 250,
        observedAt: new Date("2026-08-02T12:00:00Z"),
        raw: { ftp: 250, source: "profile", refreshed: true },
      }),
    ).resolves.toBe(false);
    await expect(
      recordProviderThresholdObservation(context.db, {
        ...base,
        value: 265,
        observedAt: new Date("2026-08-03T12:00:00Z"),
        raw: { ftp: 265, source: "profile" },
      }),
    ).resolves.toBe(true);
    await expect(
      recordProviderThresholdObservation(context.db, {
        ...base,
        value: 250,
        observedAt: new Date("2026-08-04T12:00:00Z"),
        raw: { ftp: 250, source: "profile", reverted: true },
      }),
    ).resolves.toBe(true);

    const rows = await context.db.execute<{
      value: number;
      observed_at: string;
      raw: Record<string, unknown>;
    }>(sql`
      SELECT value, observed_at, raw
      FROM fitness.provider_threshold_observation
      WHERE user_id = ${TEST_USER_ID}
        AND provider_id = 'threshold_test'
      ORDER BY observed_at
    `);

    expect(rows).toEqual([
      {
        value: 250,
        observed_at: "2026-08-01 12:00:00+00",
        raw: { ftp: 250, source: "profile" },
      },
      {
        value: 265,
        observed_at: "2026-08-03 12:00:00+00",
        raw: { ftp: 265, source: "profile" },
      },
      {
        value: 250,
        observed_at: "2026-08-04 12:00:00+00",
        raw: { ftp: 250, source: "profile", reverted: true },
      },
    ]);
  });
});
