import type { Database } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "./activity-repository.ts";

const {
  mockActivityWeekList,
  mockAnomalyHistory,
  mockJournalEntries,
  mockNutritionQuality,
  mockProcessingStatus,
} = vi.hoisted(() => ({
  mockActivityWeekList: vi.fn(),
  mockAnomalyHistory: vi.fn(),
  mockJournalEntries: vi.fn(),
  mockNutritionQuality: vi.fn(),
  mockProcessingStatus: vi.fn(),
}));

vi.mock("./activities-calendar-repository.ts", () => ({
  ActivitiesCalendarRepository: class {
    getWeekList = mockActivityWeekList;
  },
}));
vi.mock("./anomaly-detection-repository.ts", () => ({
  AnomalyDetectionRepository: class {
    getHistory = mockAnomalyHistory;
  },
}));
vi.mock("./journal-repository.ts", () => ({
  JournalRepository: class {
    listEntries = mockJournalEntries;
  },
}));
vi.mock("./nutrition-analytics-repository.ts", () => ({
  NutritionAnalyticsRepository: class {
    getMicronutrientDataQuality = mockNutritionQuality;
  },
}));
vi.mock("./processing-repository.ts", () => ({
  ProcessingRepository: class {
    status = mockProcessingStatus;
  },
}));

import { DataQualityRepository } from "./data-quality-repository.ts";

const database: Database = Object.create(null);
const sensorStore: ActivitySensorStore = {
  query: vi.fn(),
  getActivitySummaries: vi.fn().mockResolvedValue([]),
  getPowerCurveSamples: vi.fn().mockResolvedValue([]),
  getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
  getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
  getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
  getPaceCurveRows: vi.fn().mockResolvedValue([]),
  getStream: vi.fn().mockResolvedValue([]),
  getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
  getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
  refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
};

describe("DataQualityRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "failed",
      datasets: [
        { label: "Activities", status: "failed" },
        { label: "Sleep", status: "ready" },
      ],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 25,
      usableDays: 23,
      overlapDays: 3,
      conflictDays: 1,
      completenessPercent: 76.7,
      sourceLabels: ["Cronometer", "Manual"],
      contributingSourceLabels: ["Manual"],
      excludedSourceLabels: ["Cronometer"],
    });
    mockActivityWeekList.mockResolvedValue([
      {
        date: "2026-07-21",
        activities: [
          { source: { overlapSummary: "2 matched source records" } },
          { source: { overlapSummary: null } },
        ],
      },
    ]);
    mockAnomalyHistory.mockResolvedValue([
      {
        date: "2026-07-20",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 4,
        zScore: 3.75,
        severity: "alert",
      },
    ]);
    mockJournalEntries.mockResolvedValue([
      { date: "2026-07-19", source: { providerId: "dofek" } },
      { date: "2026-07-18", source: { providerId: "garmin" } },
    ]);
  });

  it("combines existing server-side quality signals into one overview", async () => {
    const repository = new DataQualityRepository(
      database,
      "10000000-0000-4000-8000-000000000001",
      "UTC",
      sensorStore,
    );

    await expect(repository.overview("2026-07-22")).resolves.toMatchObject({
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "attention",
      checks: [
        expect.objectContaining({
          key: "coverage",
          status: "attention",
          count: 5,
          message: "Nutrition data is missing for 5 of the last 30 days.",
        }),
        expect.objectContaining({
          key: "source_overlap",
          status: "attention",
          count: 4,
          details: [
            "Nutrition: 3 overlapping days (1 unresolved).",
            "Activities: 1 record has matched source records.",
          ],
        }),
        expect.objectContaining({
          key: "sync_freshness",
          status: "attention",
          count: 1,
        }),
        expect.objectContaining({ key: "outliers", status: "attention", count: 1 }),
        expect.objectContaining({
          key: "manual_edits",
          status: "informational",
          count: 1,
          lastObservedDate: "2026-07-19",
        }),
      ],
    });
    expect(mockActivityWeekList).toHaveBeenCalledWith({
      weeks: 1,
      endDate: "2026-07-22",
      includeProviderAbsent: true,
    });
    expect(mockAnomalyHistory).toHaveBeenCalledWith(30, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(30);
  });
});
