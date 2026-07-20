import { describe, expect, it, vi } from "vitest";
import {
  fetchDailySleepPerformanceNights,
  fetchLatestSleepNight,
  fetchSleepNights,
} from "./clickhouse-sleep-repository.ts";

describe("fetchDailySleepPerformanceNights", () => {
  it("reads daily sleep summary rows with full access params", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "provider-a",
        source_name: "Apple Watch",
        source_providers: ["apple_health"],
        started_at: "2026-03-13T22:00:00Z",
        ended_at: "2026-03-14T06:00:00Z",
        duration_minutes: 480,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 260,
        awake_minutes: 30,
        efficiency_pct: 92,
      },
    ]);

    const rows = await fetchDailySleepPerformanceNights({
      sensorStore: { query },
      userId: "user-1",
      endDate: "2026-03-15",
      days: 90,
      accessWindow: { kind: "full", paid: true, reason: "paid_grant" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.duration_minutes).toBe(480);
    expect(String(query.mock.calls[0]?.[1])).toContain("analytics.daily_sleep AS sleep FINAL");
    expect(String(query.mock.calls[0]?.[1])).not.toContain("accessStartDate");
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      userId: "user-1",
      endDate: "2026-03-15",
      days: 90,
    });
  });

  it("passes limited access windows to the daily sleep query", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await fetchDailySleepPerformanceNights({
      sensorStore: { query },
      userId: "user-1",
      endDate: "2026-03-15",
      days: 90,
      accessWindow: {
        kind: "limited",
        startDate: "2026-03-01",
        endDateExclusive: "2026-03-10",
      },
    });

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).toContain("sleep.date >= toDate({accessStartDate:String})");
    expect(queryText).toContain("sleep.date < toDate({accessEndDateExclusive:String})");
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      accessStartDate: "2026-03-01",
      accessEndDateExclusive: "2026-03-10",
    });
  });
});

describe("fetchSleepNights", () => {
  it("selects provenance fields from the stored daily sleep model", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "whoop",
        source_name: "WHOOP 4.0",
        source_providers: ["whoop", "apple_health"],
        started_at: "2026-03-13T22:00:00Z",
        ended_at: "2026-03-14T06:00:00Z",
        duration_minutes: 480,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 260,
        awake_minutes: 30,
        efficiency_pct: 92,
      },
    ]);

    const rows = await fetchSleepNights({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
      endDate: "2026-03-15",
      days: 30,
    });

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).toContain("analytics.daily_sleep AS sleep FINAL");
    expect(queryText).not.toContain("analytics.v_sleep");
    expect(queryText).toContain("source_name");
    expect(queryText).toContain("source_providers");
    expect(rows[0]).toMatchObject({
      provider_id: "whoop",
      source_name: "WHOOP 4.0",
      source_providers: ["whoop", "apple_health"],
    });
  });

  it("defaults missing provenance fields to null and an empty list", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "whoop",
        started_at: "2026-03-13T22:00:00Z",
        ended_at: "2026-03-14T06:00:00Z",
        duration_minutes: 480,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: 92,
      },
    ]);

    const rows = await fetchSleepNights({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
      endDate: "2026-03-15",
      days: 30,
    });

    expect(rows[0]?.source_name).toBeNull();
    expect(rows[0]?.source_providers).toEqual([]);
  });

  it("defaults null provenance fields to null and an empty list", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "whoop",
        source_name: null,
        source_providers: null,
        started_at: "2026-03-13T22:00:00Z",
        ended_at: "2026-03-14T06:00:00Z",
        duration_minutes: 480,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: 92,
      },
    ]);

    const rows = await fetchSleepNights({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
      endDate: "2026-03-15",
      days: 30,
    });

    expect(rows[0]?.source_name).toBeNull();
    expect(rows[0]?.source_providers).toEqual([]);
  });

  it("preserves full-history, ordering, limit, access, and query options", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const queryOptions = { priority: "dashboard" as const };

    await fetchSleepNights({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
      endDate: "2026-03-15",
      days: null,
      order: "desc",
      limit: 5,
      accessWindow: {
        kind: "limited",
        startDate: "2026-03-01",
        endDateExclusive: "2026-03-16",
      },
      queryOptions,
    });

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).not.toContain("{days:UInt32}");
    expect(queryText).toContain("sleep.date >= toDate({accessStartDate:String})");
    expect(queryText).toContain("sleep.date < toDate({accessEndDateExclusive:String})");
    expect(queryText).toContain("ORDER BY sleep.date DESC");
    expect(queryText).toContain("LIMIT {limit:UInt32}");
    expect(query.mock.calls[0]?.[2]).toEqual({
      userId: "user-1",
      endDate: "2026-03-15",
      limit: 5,
      accessStartDate: "2026-03-01",
      accessEndDateExclusive: "2026-03-16",
    });
    expect(query.mock.calls[0]?.[3]).toBe(queryOptions);
  });

  it("selects the latest sleep night from the stored daily sleep model", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "whoop",
        source_name: "WHOOP 4.0",
        source_providers: ["whoop"],
        started_at: "2026-03-13T22:00:00Z",
        ended_at: "2026-03-14T06:00:00Z",
        duration_minutes: 480,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: 92,
      },
    ]);

    const row = await fetchLatestSleepNight({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
    });

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).toContain("analytics.daily_sleep AS sleep FINAL");
    expect(queryText).not.toContain("analytics.v_sleep");
    expect(queryText).toContain("source_name");
    expect(queryText).toContain("source_providers");
    expect(row).toMatchObject({
      provider_id: "whoop",
      source_name: "WHOOP 4.0",
      source_providers: ["whoop"],
    });
  });

  it("applies an end date and limited access window to the latest stored night", async () => {
    const query = vi.fn().mockResolvedValue([]);

    await fetchLatestSleepNight({
      sensorStore: { query },
      userId: "user-1",
      timezone: "UTC",
      endDate: "2026-03-15",
      accessWindow: {
        kind: "limited",
        startDate: "2026-03-01",
        endDateExclusive: "2026-03-16",
      },
    });

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).toContain("sleep.date <= toDate({endDate:String})");
    expect(queryText).toContain("sleep.date >= toDate({accessStartDate:String})");
    expect(queryText).toContain("sleep.date < toDate({accessEndDateExclusive:String})");
    expect(query.mock.calls[0]?.[2]).toEqual({
      userId: "user-1",
      endDate: "2026-03-15",
      accessStartDate: "2026-03-01",
      accessEndDateExclusive: "2026-03-16",
    });
  });
});
