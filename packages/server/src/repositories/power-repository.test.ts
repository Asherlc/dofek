import { describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { PowerRepository } from "./power-repository.ts";

const history = {
  event_at: "2026-08-01T00:00:00Z",
  activity_id: null,
  eftp: 245,
  evidence_activity_id: "00000000-0000-4000-8000-000000000101",
  evidence_at: "2026-05-01T12:00:00Z",
  evidence_duration_seconds: 1200,
  evidence_power: 260,
  model_version: "v1",
};
function store() {
  return {
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ConstructorParameters<typeof PowerRepository>[2];
}
describe("PowerRepository", () => {
  it("avoids ClickHouse when the database reports no visible cycling activities", async () => {
    const sensor = store();
    const db = { execute: vi.fn().mockResolvedValue([{ activity_count: 0 }]) };
    expect(
      await new PowerRepository("user", "UTC", sensor, db).getPowerCurve(ChartRange.fromDays(90)),
    ).toEqual({ points: [], model: null });
    expect(db.execute).toHaveBeenCalledOnce();
    expect(sensor.query).not.toHaveBeenCalled();
  });
  it("aggregates canonical duration evidence for separately labeled CP exploration", async () => {
    const sensor = store();
    sensor.query.mockResolvedValueOnce([
      { duration_seconds: 300, best_power: 280, activity_date: "2026-05-01" },
      { duration_seconds: 300, best_power: 300, activity_date: "2026-06-01" },
    ]);
    const result = await new PowerRepository("user", "UTC", sensor).getPowerCurve(
      ChartRange.fromDays(90),
    );
    expect(result.points).toEqual([
      { durationSeconds: 300, label: "5min", bestPower: 300, activityDate: "2026-06-01" },
    ]);
  });
  it("renders canonical ongoing history and independently resolved current evidence", async () => {
    const sensor = store();
    sensor.query.mockImplementation(async (_schema, sql) =>
      sql.includes("ORDER BY history.event_at DESC")
        ? [history]
        : [{ date: "2026-07-01", eftp: 250, activityName: "Easy ride" }],
    );
    const result = await new PowerRepository("user", "UTC", sensor).getEftpTrend(
      ChartRange.fromDays(30),
    );
    expect(result.trend).toEqual([{ date: "2026-07-01", eftp: 250, activityName: "Easy ride" }]);
    expect(result.currentEftp).toBe(245);
    expect(result.currentEvidence).toMatchObject({ value: 245, evidence_duration_seconds: 1200 });
  });
  it("keeps current evidence when the requested display range has no trend points", async () => {
    const sensor = store();
    sensor.query.mockImplementation(async (_schema, sql) =>
      sql.includes("ORDER BY history.event_at DESC") ? [history] : [],
    );
    const result = await new PowerRepository("user", "UTC", sensor).getEftpTrend(
      ChartRange.fromDays(7),
    );
    expect(result.trend).toEqual([]);
    expect(result.currentEftp).toBe(245);
  });
  it("reports insufficient computed evidence", async () => {
    const result = await new PowerRepository("user", "UTC", store()).getEftpTrend(
      ChartRange.fromDays(7),
    );
    expect(result.currentEftp).toBeNull();
    expect(result.currentEvidence.unavailable_reason).toContain(
      "qualifying cycling power evidence",
    );
  });
});
