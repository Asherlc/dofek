import { describe, expect, it, vi } from "vitest";
import { fetchDailySleepPerformanceNights } from "./clickhouse-sleep-repository.ts";

describe("fetchDailySleepPerformanceNights", () => {
  it("reads daily sleep summary rows with full access params", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-03-14",
        provider_id: "provider-a",
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
