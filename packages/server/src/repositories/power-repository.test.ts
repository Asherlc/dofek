import { describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { PowerRepository } from "./power-repository.ts";

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
});
