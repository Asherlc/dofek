// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProviderSyncTriggerAccess = vi.fn();
const mockActiveSyncsAccess = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockSyncDofekFoodToHealthKit = vi.fn();
const mockCaptureException = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockIsAvailable = vi.fn();
const mockHasEverAuthorized = vi.fn();
const mockGetRequestStatus = vi.fn();
const mockWriteDietarySamples = vi.fn();
const mockDeleteDietarySamples = vi.fn();
const mockTrpcClient = {};

vi.mock("./trpc", () => ({
  trpc: {
    sync: {
      get triggerSync() {
        mockProviderSyncTriggerAccess();
        return { useMutation: vi.fn() };
      },
      get activeSyncs() {
        mockActiveSyncsAccess();
        return { useQuery: vi.fn() };
      },
    },
    useUtils: () => ({
      client: mockTrpcClient,
      sync: { syncStatus: { fetch: mockSyncStatusFetch } },
    }),
  },
}));

vi.mock("../modules/health-kit", async () => {
  const { createEmptyAnchoredQueryResult } = await import("../modules/health-kit/test-helpers");
  return {
    completeAnchoredQuery: vi.fn().mockResolvedValue(true),
    isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
    hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
    getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
    requestPermissions: vi.fn().mockResolvedValue(true),
    queryAnchoredSamples: vi.fn().mockResolvedValue(createEmptyAnchoredQueryResult()),
    queryDailyStatistics: vi.fn(),
    queryQuantitySamples: vi.fn(),
    queryWorkouts: vi.fn(),
    querySleepSamples: vi.fn(),
    queryWorkoutRoutes: vi.fn(),
    writeDietarySamples: (...args: unknown[]) => mockWriteDietarySamples(...args),
    deleteDietarySamples: (...args: unknown[]) => mockDeleteDietarySamples(...args),
  };
});

vi.mock("./health-kit-food-writeback", () => ({
  syncDofekFoodToHealthKit: (...args: unknown[]) => mockSyncDofekFoodToHealthKit(...args),
}));

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

const { useHealthKitFoodWriteback } = await import("./useHealthKitFoodWriteback");

describe("useHealthKitFoodWriteback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T10:00:00"));
    mockIsAvailable.mockReturnValue(true);
    mockHasEverAuthorized.mockReturnValue(true);
    mockGetRequestStatus.mockResolvedValue("unnecessary");
    mockSyncDofekFoodToHealthKit.mockResolvedValue({ written: 1, skipped: 0, errors: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes Dofek food to HealthKit for the uncovered date range", async () => {
    renderHook(() => useHealthKitFoodWriteback("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncDofekFoodToHealthKit).toHaveBeenCalledWith({
      trpcClient: mockTrpcClient,
      healthKit: {
        writeDietarySamples: expect.any(Function),
        deleteDietarySamples: expect.any(Function),
      },
      startDate: "2026-03-21",
      endDate: "2026-03-22",
    });
  });

  it("does not use provider trigger, active-sync, or sync-status APIs", async () => {
    renderHook(() => useHealthKitFoodWriteback("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockProviderSyncTriggerAccess).not.toHaveBeenCalled();
    expect(mockActiveSyncsAccess).not.toHaveBeenCalled();
    expect(mockSyncStatusFetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    "2026-03-22",
  ])("does not write food without an uncovered range (%s)", async (latestDate) => {
    renderHook(() => useHealthKitFoodWriteback(latestDate));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncDofekFoodToHealthKit).not.toHaveBeenCalled();
  });

  it("does not write food when HealthKit is unavailable", async () => {
    mockIsAvailable.mockReturnValue(false);

    renderHook(() => useHealthKitFoodWriteback("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncDofekFoodToHealthKit).not.toHaveBeenCalled();
  });

  it("attempts writeback even when legacy authorization has not been recorded", async () => {
    mockHasEverAuthorized.mockReturnValue(false);

    renderHook(() => useHealthKitFoodWriteback("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncDofekFoodToHealthKit).toHaveBeenCalledOnce();
  });

  it("reports unexpected HealthKit writeback errors to Sentry", async () => {
    const error = new Error("HealthKit write failed");
    mockSyncDofekFoodToHealthKit.mockRejectedValue(error);

    renderHook(() => useHealthKitFoodWriteback("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "health-kit-food-writeback",
    });
  });
});
