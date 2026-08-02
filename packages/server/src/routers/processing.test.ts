import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockAlerts, mockDataQuality, mockEnsureProvidersRegistered, mockHistory, mockStatus } =
  vi.hoisted(() => ({
    mockAlerts: vi.fn(),
    mockDataQuality: vi.fn(),
    mockEnsureProvidersRegistered: vi.fn(),
    mockHistory: vi.fn(),
    mockStatus: vi.fn(),
  }));

vi.mock("../repositories/processing-repository.ts", () => ({
  ProcessingRepository: class {
    alerts = mockAlerts;
    status = mockStatus;
    history = mockHistory;
  },
}));
vi.mock("../repositories/data-quality-repository.ts", () => ({
  DataQualityRepository: class {
    overview = mockDataQuality;
  },
}));
vi.mock("./sync-helpers.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

import { processingRouter } from "./processing.ts";

const createCaller = createTestCallerFactory(processingRouter);
const userId = "10000000-0000-4000-8000-000000000001";

describe("processingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
  });

  it("validates the processing history response at runtime", async () => {
    mockHistory.mockResolvedValue({
      operations: [
        {
          id: "10000000-0000-4000-8000-000000000002",
          userId,
          providerId: "kaya-export",
          kind: "file_import",
          externalCorrelationKey: "import-1",
          datasetKeys: ["activity"],
          createdAt: "not-a-date",
        },
      ],
      nextCursor: null,
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.history({ limit: 20 })).rejects.toThrow();
  });

  it("normalizes processing history timestamps to ISO strings", async () => {
    mockHistory.mockResolvedValue({
      operations: [
        {
          id: "10000000-0000-4000-8000-000000000002",
          userId,
          providerId: "kaya-export",
          kind: "file_import",
          externalCorrelationKey: "import-1",
          datasetKeys: ["activity"],
          createdAt: new Date("2026-07-22T12:00:00.000Z"),
        },
      ],
      nextCursor: null,
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    const result = await caller.history({ limit: 20 });

    expect(result.operations[0]?.createdAt).toBe("2026-07-22T12:00:00.000Z");
  });

  it("returns structured customer alerts", async () => {
    mockAlerts.mockResolvedValue({
      generatedAt: "2026-07-22T12:00:00.000Z",
      alerts: [
        {
          id: "10000000-0000-4000-8000-000000000002:providers",
          providerId: "garmin",
          providerLabel: "Garmin",
          datasetKey: "providers",
          occurredAt: "2026-07-22T11:59:00.000Z",
          title: "Garmin summary wasn’t updated",
          message: "Your Garmin data is still available.",
          action: "retry_sync",
          actionLabel: "Retry Garmin sync",
        },
      ],
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T12:00:00.000Z",
      alerts: [
        expect.objectContaining({
          providerLabel: "Garmin",
          action: "retry_sync",
        }),
      ],
    });
  });

  it("returns the server-owned data quality overview", async () => {
    mockDataQuality.mockResolvedValue({
      generatedAt: "2026-07-22T12:00:00.000Z",
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "attention",
      overallMessage: "1 data quality check needs review.",
      checks: [
        {
          key: "source_overlap",
          label: "Source overlap",
          status: "attention",
          title: "Some records have overlapping sources",
          message: "Review the source decisions before interpreting these records.",
          count: 2,
          lastObservedDate: "2026-07-21",
          details: ["Nutrition: 2 overlapping days."],
        },
      ],
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.dataQuality({ endDate: "2026-07-22" })).resolves.toEqual({
      generatedAt: "2026-07-22T12:00:00.000Z",
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "attention",
      overallMessage: "1 data quality check needs review.",
      checks: [
        {
          key: "source_overlap",
          label: "Source overlap",
          status: "attention",
          title: "Some records have overlapping sources",
          message: "Review the source decisions before interpreting these records.",
          count: 2,
          lastObservedDate: "2026-07-21",
          details: ["Nutrition: 2 overlapping days."],
        },
      ],
    });
    expect(mockEnsureProvidersRegistered).toHaveBeenCalledOnce();
    expect(mockDataQuality).toHaveBeenCalledWith("2026-07-22");
  });

  it("normalizes data-quality dates and timestamps from database values", async () => {
    mockDataQuality.mockResolvedValue({
      generatedAt: new Date("2026-07-22T12:00:00.000Z"),
      window: { days: 30, endDate: new Date("2026-07-23T00:00:00.000Z") },
      overallStatus: "healthy",
      overallMessage: "Your recent data is ready to interpret.",
      checks: [
        {
          key: "coverage",
          label: "Missing days",
          status: "healthy",
          title: "Coverage is complete",
          message: "Nutrition data is present for all 30 days in the selected window.",
          count: 0,
          lastObservedDate: new Date("2026-07-23T00:00:00.000Z"),
          details: [],
        },
      ],
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.dataQuality({ endDate: "2026-07-23" })).resolves.toMatchObject({
      generatedAt: "2026-07-22T12:00:00.000Z",
      window: { endDate: "2026-07-23" },
      checks: [{ lastObservedDate: "2026-07-23" }],
    });
  });

  it("forwards the server default date when the client omits endDate", async () => {
    mockDataQuality.mockResolvedValue({
      generatedAt: "2026-07-22T12:00:00.000Z",
      window: { days: 30, endDate: "2026-07-22" },
      overallStatus: "healthy",
      overallMessage: "Your recent data is ready to interpret.",
      checks: [],
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await caller.dataQuality({});

    expect(mockEnsureProvidersRegistered).toHaveBeenCalledOnce();
    expect(mockDataQuality).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
});
