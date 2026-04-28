// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mutable mock state ---
const mockMutateAsync = vi.fn();
const mockInvalidate = vi.fn();
const mockSyncStatusFetch = vi.fn();
let mockActiveSyncs: { data: unknown[] | undefined; isLoading: boolean };

vi.mock("./trpc", () => ({
  trpc: {
    sync: {
      triggerSync: {
        useMutation: () => ({ mutateAsync: mockMutateAsync }),
      },
      activeSyncs: {
        useQuery: () => mockActiveSyncs,
      },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      sync: {
        syncStatus: { fetch: mockSyncStatusFetch },
      },
      client: {},
    }),
  },
}));

const mockIsAvailable = vi.fn().mockReturnValue(false);
const mockHasEverAuthorized = vi.fn().mockReturnValue(false);

vi.mock("../modules/health-kit", () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  queryDailyStatistics: vi.fn(),
  queryQuantitySamples: vi.fn(),
  queryWorkouts: vi.fn(),
  querySleepSamples: vi.fn(),
  queryWorkoutRoutes: vi.fn(),
  writeDietarySamples: vi.fn(),
  deleteDietarySamples: vi.fn(),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockSyncHealthKitToServer = vi.fn();

vi.mock("./health-kit-sync", () => ({
  syncHealthKitToServer: (...args: unknown[]) => mockSyncHealthKitToServer(...args),
}));

const mockSyncDofekFoodToHealthKit = vi.fn();

vi.mock("./health-kit-food-writeback", () => ({
  syncDofekFoodToHealthKit: (...args: unknown[]) => mockSyncDofekFoodToHealthKit(...args),
}));

const { useAutoSync, isDataStale } = await import("./useAutoSync");

describe("isDataStale", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when latestDate is null", () => {
    expect(isDataStale(null)).toBe(false);
  });

  it("returns false when latestDate is undefined", () => {
    expect(isDataStale(undefined)).toBe(false);
  });

  it("returns false when latestDate matches today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    expect(isDataStale("2026-03-21")).toBe(false);
  });

  it("returns true when latestDate is yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    expect(isDataStale("2026-03-20")).toBe(true);
  });

  it("returns true when latestDate is older", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    expect(isDataStale("2026-03-15")).toBe(true);
  });
});

describe("useAutoSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T10:00:00"));
    mockActiveSyncs = { data: [], isLoading: false };
    mockMutateAsync.mockResolvedValue({ jobId: "test-job" });
    mockSyncStatusFetch.mockResolvedValue({ status: "done" });
    mockIsAvailable.mockReturnValue(false);
    mockSyncDofekFoodToHealthKit.mockResolvedValue({ written: 0, skipped: 0, errors: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not trigger sync when data is not stale", async () => {
    renderHook(() => useAutoSync("2026-03-22"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("does not trigger sync when latestDate is null", async () => {
    renderHook(() => useAutoSync(null));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("does not trigger sync while activeSyncs is loading", async () => {
    mockActiveSyncs.isLoading = true;
    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("does not trigger sync when there are active syncs", async () => {
    mockActiveSyncs.data = [{ id: "existing-sync" }];
    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("triggers sync and invalidates cache when job completes", async () => {
    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalledWith({ sinceDays: 1 });
    expect(mockSyncStatusFetch).toHaveBeenCalledWith({ jobId: "test-job" }, { staleTime: 0 });
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("polls multiple times before completing", async () => {
    mockSyncStatusFetch
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "done" });

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(3);
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("invalidates cache on error status", async () => {
    mockSyncStatusFetch.mockResolvedValue({ status: "error" });

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("invalidates cache when syncStatus returns null", async () => {
    mockSyncStatusFetch.mockResolvedValue(null);

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("catches sync failure and calls captureException", async () => {
    const syncError = new Error("network error");
    mockMutateAsync.mockRejectedValue(syncError);

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
      source: "auto-sync-providers",
    });
  });

  it("only triggers once across re-renders", async () => {
    const { rerender } = renderHook(({ date }) => useAutoSync(date), {
      initialProps: { date: "2026-03-21" },
    });
    await act(() => vi.runAllTimersAsync());

    rerender({ date: "2026-03-21" });
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  describe("HealthKit sync", () => {
    beforeEach(() => {
      mockIsAvailable.mockReturnValue(true);
      mockHasEverAuthorized.mockReturnValue(true);
      mockSyncHealthKitToServer.mockResolvedValue({
        inserted: 5,
        errors: [],
      });
    });

    it("triggers HealthKit sync and invalidates on success", async () => {
      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).toHaveBeenCalledWith(
        expect.objectContaining({ syncRangeDays: 1 }),
      );
      expect(mockInvalidate).toHaveBeenCalled();
    });

    it("writes direct Dofek food entries back to HealthKit after HealthKit sync", async () => {
      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncDofekFoodToHealthKit).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-03-21",
          endDate: "2026-03-22",
        }),
      );
    });

    it("skips HealthKit sync when never authorized", async () => {
      mockHasEverAuthorized.mockReturnValue(false);

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).not.toHaveBeenCalled();
    });

    it("syncs even when new types need permission (shouldRequest)", async () => {
      // hasEverAuthorized is true — sync should proceed regardless of
      // what getRequestStatus would return for new types
      mockHasEverAuthorized.mockReturnValue(true);

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).toHaveBeenCalledWith(
        expect.objectContaining({ syncRangeDays: 1 }),
      );
    });

    it("skips HealthKit sync when not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).not.toHaveBeenCalled();
    });

    it("catches HealthKit sync failure and calls captureException", async () => {
      const hkError = new Error("hk error");
      mockSyncHealthKitToServer.mockRejectedValue(hkError);

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(hkError, {
        source: "auto-sync-healthkit",
      });
    });
  });
});
