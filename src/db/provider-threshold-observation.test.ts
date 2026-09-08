import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { recordProviderThresholdObservation } from "./provider-threshold-observation.ts";

const dialect = new PgDialect();

describe("recordProviderThresholdObservation", () => {
  it("appends a new immutable value and suppresses an unchanged latest value", async () => {
    const execute = vi.fn().mockResolvedValue([{ inserted: true }]);

    const inserted = await recordProviderThresholdObservation(
      { execute },
      {
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "zwift",
        providerRecordId: "profile:12345",
        sport: "cycling",
        thresholdType: "ftp",
        value: 250,
        unit: "watt",
        observedAt: new Date("2026-09-07T12:00:00Z"),
        raw: { ftp: 250 },
      },
    );

    expect(inserted).toBe(true);
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("INSERT INTO fitness.provider_threshold_observation");
    expect(query.sql).toContain("ORDER BY observed_at DESC");
    expect(query.sql).toContain("IS NOT DISTINCT FROM");
    expect(query.sql).not.toContain("DO UPDATE");
    expect(query.params).toEqual(
      expect.arrayContaining([
        "00000000-0000-0000-0000-000000000001",
        "zwift",
        "profile:12345",
        "cycling",
        "ftp",
        250,
        "watt",
        new Date("2026-09-07T12:00:00Z"),
        JSON.stringify({ ftp: 250 }),
      ]),
    );
  });

  it("reports that an unchanged observation was not inserted", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(
      recordProviderThresholdObservation(
        { execute },
        {
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "zwift",
          providerRecordId: "power-profile:12345",
          sport: "cycling",
          thresholdType: "ftp",
          value: 255,
          unit: "watt",
          observedAt: new Date("2026-09-07T12:00:00Z"),
          raw: { zFtp: 255 },
        },
      ),
    ).resolves.toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid threshold value %s",
    async (value) => {
      const execute = vi.fn();

      await expect(
        recordProviderThresholdObservation(
          { execute },
          {
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "zwift",
            providerRecordId: "profile:12345",
            sport: "cycling",
            thresholdType: "ftp",
            value,
            unit: "watt",
            observedAt: new Date("2026-09-07T12:00:00Z"),
            raw: {},
          },
        ),
      ).rejects.toThrow("threshold value must be a positive finite number");
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
