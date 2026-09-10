import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

const configuredId = "00000000-0000-4000-8000-000000000101";

const configuredRow = {
  id: configuredId,
  evidence_kind: "configured",
  sport: "cycling",
  threshold_type: "ftp",
  value: 245,
  unit: "watt",
  event_at: "2026-06-01T07:00:00.000Z",
  observed_at: "2026-05-28T16:00:00.000Z",
  effective_at: "2026-06-01T07:00:00.000Z",
  provider_id: null,
  provider_record_id: null,
  raw_available: false,
};

describe("CyclingThresholdRepository", () => {
  it("keeps configured and legacy values distinct", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([configuredRow])
      .mockResolvedValueOnce([{ ftp: 240 }]);

    const result = await new CyclingThresholdRepository(
      { execute },
      "00000000-0000-4000-8000-000000000001",
      "America/Los_Angeles",
    ).listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: null,
      limit: 100,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        id: configuredId,
        evidence_kind: "configured",
        value_kind: "configured",
        historical_validity: "effective_dated",
        provider: null,
      }),
    ]);
    expect(result.legacy_current).toEqual({
      value: 240,
      unit: "watt",
      source: "user_profile.ftp",
      value_kind: "configured",
      historical_validity: "unknown",
      reason:
        "Legacy current FTP has no effective date and is not applied to historical activities",
    });
  });

  it("binds exact dates, timezone, providers, page size, and an opaque cursor", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        configuredRow,
        { ...configuredRow, id: "00000000-0000-4000-8000-000000000103" },
      ])
      .mockResolvedValueOnce([{ ftp: 240 }]);
    const repository = new CyclingThresholdRepository(
      { execute },
      "00000000-0000-4000-8000-000000000001",
      "America/Los_Angeles",
    );

    const first = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: null,
      limit: 1,
    });

    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.legacy_current).toMatchObject({ value: 240 });
    const firstQuery = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(firstQuery.sql).toContain("LIMIT");
    expect(firstQuery.params).toEqual(
      expect.arrayContaining(["2026-05-01", "2026-08-01", "America/Los_Angeles", 2]),
    );

    execute.mockReset().mockResolvedValue([]);
    const second = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: first.next_cursor,
      limit: 1,
    });
    expect(second.items).toEqual([]);
    const secondQuery = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(secondQuery.sql).toContain("history.event_at <");
  });

  it("rejects a cursor reused with changed filters before querying", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        configuredRow,
        { ...configuredRow, id: "00000000-0000-4000-8000-000000000103" },
      ])
      .mockResolvedValueOnce([{ ftp: 240 }]);
    const repository = new CyclingThresholdRepository(
      { execute },
      "00000000-0000-4000-8000-000000000001",
      "UTC",
    );
    const first = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: null,
      limit: 1,
    });

    await expect(
      repository.listHistory({
        startDate: "2026-05-01",
        endDate: "2026-08-02",
        cursor: first.next_cursor,
        limit: 1,
      }),
    ).rejects.toThrow("Cursor does not match this request");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
