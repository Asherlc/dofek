import type { AnyRouter } from "@trpc/server";
import { initTRPC } from "@trpc/server";
import { vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { Context } from "../trpc.ts";

const trpc = initTRPC.context<Context>().create();

export function createTestCallerFactory(router: AnyRouter) {
  return trpc.createCallerFactory(router);
}

/**
 * Construct an in-memory ActivitySensorStore that returns `rows` (or successive
 * rowsets if `rows` is an array of arrays) from `query()`. All other store
 * methods stub out to empty arrays. Use in router/repo tests that exercise
 * code paths reading from analytics.activity_summary / analytics.deduped_sensor.
 */
function isMatrix(rows: unknown[] | unknown[][]): rows is unknown[][] {
  return rows.length > 0 && Array.isArray(rows[0]);
}

export function makeMockSensorStore(rows: unknown[] | unknown[][] = []): ActivitySensorStore {
  let queryMock: ReturnType<typeof vi.fn>;
  if (isMatrix(rows)) {
    queryMock = vi.fn();
    for (const batch of rows) {
      queryMock.mockResolvedValueOnce(batch);
    }
  } else {
    queryMock = vi.fn().mockResolvedValue(rows);
  }
  return {
    query: queryMock,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

export function metricRow(
  overrides: Partial<{
    date: string;
    hrv: number | null;
    resting_hr: number | null;
    respiratory_rate: number | null;
    efficiency_pct: number | null;
    hrv_mean_30d: number | null;
    hrv_sd_30d: number | null;
    rhr_mean_30d: number | null;
    rhr_sd_30d: number | null;
    rr_mean_30d: number | null;
    rr_sd_30d: number | null;
    daily_load: number;
  }> = {},
) {
  return {
    date: "2026-03-28",
    hrv: null,
    resting_hr: null,
    respiratory_rate: null,
    efficiency_pct: null,
    hrv_mean_30d: null,
    hrv_sd_30d: null,
    rhr_mean_30d: null,
    rhr_sd_30d: null,
    rr_mean_30d: null,
    rr_sd_30d: null,
    daily_load: 0,
    ...overrides,
  };
}

export function sleepBaselineRow(
  date: string,
  durationMinutes: number,
  hrv: number | null,
  load = 0,
) {
  return {
    date,
    duration_minutes: durationMinutes,
    hrv,
    yesterday_load: load,
  };
}

export function dateDaysBefore(dateString: string, daysBefore: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}
