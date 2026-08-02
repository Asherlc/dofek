import type { Database } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const {
  mockActivityWeekList,
  mockAnomalyHistory,
  mockJournalEntries,
  mockNutritionQuality,
  mockProcessingStatus,
  mockActivitiesCalendarConstructor,
  mockAnomalyDetectionConstructor,
  mockJournalConstructor,
  mockNutritionAnalyticsConstructor,
  mockProcessingConstructor,
} = vi.hoisted(() => ({
  mockActivityWeekList: vi.fn(),
  mockAnomalyHistory: vi.fn(),
  mockJournalEntries: vi.fn(),
  mockNutritionQuality: vi.fn(),
  mockProcessingStatus: vi.fn(),
  mockActivitiesCalendarConstructor: vi.fn(),
  mockAnomalyDetectionConstructor: vi.fn(),
  mockJournalConstructor: vi.fn(),
  mockNutritionAnalyticsConstructor: vi.fn(),
  mockProcessingConstructor: vi.fn(),
}));

vi.mock("./activities-calendar-repository.ts", () => ({
  ActivitiesCalendarRepository: class {
    constructor(...args: unknown[]) {
      mockActivitiesCalendarConstructor(...args);
    }

    getWeekList = mockActivityWeekList;
  },
}));
vi.mock("./anomaly-detection-repository.ts", () => ({
  AnomalyDetectionRepository: class {
    constructor(...args: unknown[]) {
      mockAnomalyDetectionConstructor(...args);
    }

    getHistory = mockAnomalyHistory;
  },
}));
vi.mock("./journal-repository.ts", () => ({
  JournalRepository: class {
    constructor(...args: unknown[]) {
      mockJournalConstructor(...args);
    }

    listEntries = mockJournalEntries;
  },
}));
vi.mock("./nutrition-analytics-repository.ts", () => ({
  NutritionAnalyticsRepository: class {
    constructor(...args: unknown[]) {
      mockNutritionAnalyticsConstructor(...args);
    }

    getMicronutrientDataQuality = mockNutritionQuality;
  },
}));
vi.mock("./processing-repository.ts", () => ({
  ProcessingRepository: class {
    constructor(...args: unknown[]) {
      mockProcessingConstructor(...args);
    }

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

function makeRepository(accessWindow?: AccessWindow): DataQualityRepository {
  return new DataQualityRepository(
    database,
    "10000000-0000-4000-8000-000000000001",
    "UTC",
    sensorStore,
    accessWindow,
  );
}

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
    const repository = makeRepository();

    await expect(repository.overview("2026-07-22")).resolves.toMatchObject({
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "attention",
      overallMessage: "4 data quality checks need review.",
      checks: [
        expect.objectContaining({
          key: "coverage",
          status: "attention",
          title: "Coverage gaps",
          count: 5,
          message: "Nutrition data is missing for 5 of the last 30 days.",
        }),
        expect.objectContaining({
          key: "source_overlap",
          status: "attention",
          count: 4,
          lastObservedDate: "2026-07-21",
          details: [
            "Nutrition: 3 overlapping days (1 unresolved).",
            "Activities: 1 record has matched source records.",
          ],
        }),
        expect.objectContaining({
          key: "sync_freshness",
          status: "attention",
          count: 1,
          message:
            "Activities could not be updated. Review the processing status on the dashboard.",
          details: ["Activities: failed."],
        }),
        expect.objectContaining({ key: "outliers", status: "attention", count: 1 }),
        expect.objectContaining({
          key: "manual_edits",
          status: "informational",
          count: 1,
          message: "1 manually entered journal record was recorded in the last 30 days.",
          lastObservedDate: "2026-07-19",
        }),
      ],
    });
    expect(mockActivityWeekList).toHaveBeenCalledWith({
      weeks: 5,
      endDate: "2026-07-22",
      includeProviderAbsent: true,
    });
    expect(mockAnomalyHistory).toHaveBeenCalledWith(30, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(30);
    expect(mockActivitiesCalendarConstructor).toHaveBeenCalledWith(
      database,
      "10000000-0000-4000-8000-000000000001",
      "UTC",
      sensorStore,
      undefined,
    );
    expect(mockAnomalyDetectionConstructor).toHaveBeenCalledWith(
      database,
      "10000000-0000-4000-8000-000000000001",
      "UTC",
      sensorStore,
    );
    expect(mockJournalConstructor).toHaveBeenCalledWith(
      database,
      "10000000-0000-4000-8000-000000000001",
    );
    expect(mockNutritionAnalyticsConstructor).toHaveBeenCalledWith(
      database,
      "10000000-0000-4000-8000-000000000001",
      "UTC",
      undefined,
    );
    expect(mockProcessingConstructor).toHaveBeenCalledWith(
      database,
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("reports a healthy overview when every quality signal is clear", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [
        { label: "Activities", status: "ready" },
        { label: "Sleep", status: "ready" },
      ],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      { date: "2026-07-22", activities: [{ source: { overlapSummary: null } }] },
    ]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([
      { date: "2026-07-21", source: { providerId: "garmin" } },
    ]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview).toMatchObject({
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "healthy",
      overallMessage: "Your recent data is ready to interpret.",
    });
    expect(overview.checks).toEqual([
      {
        key: "coverage",
        label: "Missing days",
        status: "healthy",
        title: "Coverage is complete",
        message: "Nutrition data is present for all 30 days in the selected window.",
        count: 0,
        lastObservedDate: null,
        details: ["30 of 30 days contain nutrition data."],
      },
      {
        key: "source_overlap",
        label: "Source overlap",
        status: "healthy",
        title: "Sources are distinct",
        message: "No overlapping nutrition or activity sources were detected.",
        count: 0,
        lastObservedDate: null,
        details: [],
      },
      {
        key: "sync_freshness",
        label: "Sync freshness",
        status: "healthy",
        title: "Data updates are current",
        message: "All selected datasets are ready.",
        count: 0,
        lastObservedDate: null,
        details: [],
      },
      {
        key: "outliers",
        label: "Outliers",
        status: "healthy",
        title: "No unusual observations were flagged",
        message: "No unusual observations were flagged in the last 30 days.",
        count: 0,
        lastObservedDate: null,
        details: [],
      },
      {
        key: "manual_edits",
        label: "Manual edits",
        status: "healthy",
        title: "No manual entries recorded",
        message: "No manually entered journal records were recorded in the last 30 days.",
        count: 0,
        lastObservedDate: null,
        details: [],
      },
    ]);
  });

  it("counts activity overlaps across dates and preserves the latest date", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      {
        date: "2026-07-22",
        activities: [
          { source: { overlapSummary: "matched source A" } },
          { source: { overlapSummary: "matched source B" } },
        ],
      },
      {
        date: "2026-07-20",
        activities: [{ source: { overlapSummary: null } }],
      },
    ]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview).toMatchObject({
      overallStatus: "attention",
      overallMessage: "1 data quality check needs review.",
    });
    expect(overview.checks[1]).toEqual({
      key: "source_overlap",
      label: "Source overlap",
      status: "attention",
      title: "Some records have overlapping sources",
      message: "Review the source decisions before interpreting these records.",
      count: 2,
      lastObservedDate: "2026-07-22",
      details: ["Activities: 2 records have matched source records."],
    });
  });

  it("includes activity overlaps from the complete 30-day quality window", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      {
        date: "2026-06-22",
        activities: [{ source: { overlapSummary: "matched source" } }],
      },
      {
        date: "2026-06-23",
        activities: [{ source: { overlapSummary: "matched source" } }],
      },
      {
        date: "2026-07-23",
        activities: [{ source: { overlapSummary: "matched source" } }],
      },
    ]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview.checks.find((check) => check.key === "source_overlap")).toMatchObject({
      count: 1,
      lastObservedDate: "2026-06-23",
      details: ["Activities: 1 record has matched source records."],
    });
    expect(mockActivityWeekList).toHaveBeenCalledWith({
      weeks: 5,
      endDate: "2026-07-22",
      includeProviderAbsent: true,
    });
  });

  it.each([
    ["blocked", "failed", "Activities could not be updated."],
    ["delayed", "delayed", "Activities are not current."],
    ["cancelled", "cancelled", "Activities are not current."],
    ["active", "active", "Activities are still updating."],
  ] as const)("explains %s processing state", async (overallStatus, datasetStatus, message) => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus,
      datasets: [{ label: "Activities", status: datasetStatus }],
    });

    const overview = await makeRepository().overview("2026-07-22");
    const syncCheck = overview.checks.find((check) => check.key === "sync_freshness");

    expect(syncCheck).toMatchObject({
      status: "attention",
      title: "Some data is not current",
      message: `${message} Review the processing status on the dashboard.`,
      count: 1,
      details: [`Activities: ${datasetStatus}.`],
    });
  });

  it("uses a generic processing message when no dataset is actionable", async () => {
    mockProcessingStatus.mockResolvedValue({ overallStatus: "failed", datasets: [] });

    const overview = await makeRepository().overview("2026-07-22");
    const syncCheck = overview.checks.find((check) => check.key === "sync_freshness");

    expect(syncCheck).toMatchObject({
      status: "attention",
      message: "Some data could not be updated. Review the processing status on the dashboard.",
      count: 0,
      details: [],
    });
  });

  it("flags a non-ready dataset when overall processing is still marked ready", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "failed" }],
    });

    const overview = await makeRepository().overview("2026-07-22");
    const syncCheck = overview.checks.find((check) => check.key === "sync_freshness");

    expect(syncCheck).toMatchObject({
      status: "attention",
      title: "Some data is not current",
      message: "Activities could not be updated. Review the processing status on the dashboard.",
      count: 1,
      details: ["Activities: failed."],
    });
  });

  it("describes a single nutrition overlap without activity matches", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 1,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      { date: "2026-07-22", activities: [{ source: { overlapSummary: null } }] },
    ]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview.checks.find((check) => check.key === "source_overlap")).toMatchObject({
      count: 1,
      details: ["Nutrition: 1 overlapping day (0 unresolved)."],
    });
  });

  it("does not report a negative coverage gap when the source count exceeds the window", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 31,
      usableDays: 31,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview.checks.find((check) => check.key === "coverage")).toMatchObject({
      status: "healthy",
      count: 0,
    });
  });

  it("keeps the selected quality window when access extends beyond it", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-06-20",
      endDateExclusive: "2026-07-30",
    }).overview("2026-07-22");

    expect(overview.window).toEqual({ days: 30, endDate: "2026-07-22" });
    expect(mockNutritionQuality).toHaveBeenCalledWith(30);
    expect(mockAnomalyHistory).toHaveBeenCalledWith(30, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(30);
  });

  it("uses an earlier access end when it precedes the selected quality window", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 27,
      daysWithData: 27,
      usableDays: 27,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-06-20",
      endDateExclusive: "2026-07-20",
    }).overview("2026-07-22");

    expect(overview.window).toEqual({ days: 27, endDate: "2026-07-22" });
    expect(mockNutritionQuality).toHaveBeenCalledWith(27);
    expect(mockAnomalyHistory).toHaveBeenCalledWith(27, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(27);
  });

  it("reports plural outliers and manual entries with bounded details", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      { date: "2026-07-22", activities: [{ source: { overlapSummary: null } }] },
    ]);
    mockAnomalyHistory.mockResolvedValue([
      { date: "2026-07-15", metric: "Heart rate", value: 1 },
      { date: "2026-07-22", metric: "Sleep", value: 2 },
      { date: "2026-07-20", metric: "Recovery", value: 3 },
      { date: "2026-07-18", metric: "Strain", value: 4 },
    ]);
    mockJournalEntries.mockResolvedValue([
      { date: "2026-07-10", source: { providerId: "dofek" } },
      { date: "2026-07-22", source: { providerId: "dofek" } },
      { date: "2026-07-11", source: { providerId: "garmin" } },
    ]);

    const overview = await makeRepository().overview("2026-07-22");

    expect(overview).toMatchObject({
      overallStatus: "attention",
      overallMessage: "1 data quality check needs review.",
    });
    expect(overview.checks.find((check) => check.key === "outliers")).toEqual({
      key: "outliers",
      label: "Outliers",
      status: "attention",
      title: "Unusual observations were flagged",
      message: "4 unusual observations were flagged in the last 30 days.",
      count: 4,
      lastObservedDate: "2026-07-22",
      details: ["Heart rate on 2026-07-15.", "Sleep on 2026-07-22.", "Recovery on 2026-07-20."],
    });
    expect(overview.checks.find((check) => check.key === "manual_edits")).toEqual({
      key: "manual_edits",
      label: "Manual edits",
      status: "informational",
      title: "Manual entries are included",
      message: "2 manually entered journal records were recorded in the last 30 days.",
      count: 2,
      lastObservedDate: "2026-07-22",
      details: [],
    });
  });

  it("uses the complete quality window for full access", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 30,
      daysWithData: 30,
      usableDays: 30,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 100,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([]);
    mockAnomalyHistory.mockResolvedValue([]);
    mockJournalEntries.mockResolvedValue([]);

    const overview = await makeRepository({
      kind: "full",
      paid: true,
      reason: "paid_grant",
    }).overview("2026-07-22");

    expect(overview.window).toEqual({ days: 30, endDate: "2026-07-22" });
    expect(mockNutritionQuality).toHaveBeenCalledWith(30);
    expect(mockAnomalyHistory).toHaveBeenCalledWith(30, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(30);
  });

  it("uses the accessible intersection for a restricted data-quality window", async () => {
    mockProcessingStatus.mockResolvedValue({
      overallStatus: "ready",
      datasets: [{ label: "Activities", status: "ready" }],
    });
    mockNutritionQuality.mockResolvedValue({
      selectedWindowDays: 4,
      daysWithData: 3,
      usableDays: 3,
      overlapDays: 0,
      conflictDays: 0,
      completenessPercent: 75,
      sourceLabels: [],
      contributingSourceLabels: [],
      excludedSourceLabels: [],
    });
    mockActivityWeekList.mockResolvedValue([
      {
        date: "2026-07-18",
        activities: [{ source: { overlapSummary: "outside access" } }],
      },
      {
        date: "2026-07-21",
        activities: [{ source: { overlapSummary: "inside access" } }],
      },
    ]);
    mockAnomalyHistory.mockResolvedValue([
      {
        date: "2026-07-21",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 4,
        zScore: 3.75,
        severity: "alert",
      },
    ]);
    mockJournalEntries.mockResolvedValue([{ date: "2026-07-21", source: { providerId: "dofek" } }]);

    const overview = await makeRepository({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-19",
      endDateExclusive: "2026-07-23",
    }).overview("2026-07-22");

    expect(overview).toMatchObject({
      window: { days: 4, endDate: "2026-07-22" },
      overallStatus: "attention",
    });
    expect(overview.checks.find((check) => check.key === "coverage")).toMatchObject({
      count: 1,
      message: "Nutrition data is missing for 1 of the last 4 days.",
      details: ["3 of 4 days contain nutrition data."],
    });
    expect(overview.checks.find((check) => check.key === "source_overlap")).toMatchObject({
      count: 1,
      lastObservedDate: "2026-07-21",
    });
    expect(overview.checks.find((check) => check.key === "outliers")).toMatchObject({
      message: "1 unusual observation was flagged in the last 4 days.",
    });
    expect(overview.checks.find((check) => check.key === "manual_edits")).toMatchObject({
      message: "1 manually entered journal record was recorded in the last 4 days.",
    });
    expect(mockNutritionQuality).toHaveBeenCalledWith(4);
    expect(mockAnomalyHistory).toHaveBeenCalledWith(4, "2026-07-22");
    expect(mockJournalEntries).toHaveBeenCalledWith(4);
    expect(mockActivityWeekList).toHaveBeenCalledWith({
      weeks: 1,
      endDate: "2026-07-22",
      includeProviderAbsent: true,
    });
  });
});
