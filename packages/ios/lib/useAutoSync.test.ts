// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

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
const mockGetRequestStatus = vi.fn();

vi.mock("../modules/health-kit", () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  queryDailyStatistics: vi.fn(),
  queryQuantitySamples: vi.fn(),
  queryWorkouts: vi.fn(),
  querySleepSamples: vi.fn(),
}));

const mockSyncHealthKitToServer = vi.fn();

vi.mock("./health-kit-sync", () => ({
  syncHealthKitToServer: (...args: unknown[]) =>
    mockSyncHealthKitToServer(...args),
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
    expect(mockSyncStatusFetch).toHaveBeenCalledWith(
      { jobId: "test-job" },
      { staleTime: 0 },
    );
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

  it("catches sync failure silently", async () => {
    mockMutateAsync.mockRejectedValue(new Error("network error"));

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("only triggers once across re-renders", async () => {
    const { rerender } = renderHook(
      ({ date }) => useAutoSync(date),
      { initialProps: { date: "2026-03-21" } },
    );
    await act(() => vi.runAllTimersAsync());

    rerender({ date: "2026-03-21" });
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  describe("HealthKit sync", () => {
    beforeEach(() => {
      mockIsAvailable.mockReturnValue(true);
      mockGetRequestStatus.mockResolvedValue("unnecessary");
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

    it("skips HealthKit sync when status is not unnecessary", async () => {
      mockGetRequestStatus.mockResolvedValue("determined");

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockSyncHealthKitToServer).not.toHaveBeenCalled();
    });

    it("skips HealthKit sync when not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      expect(mockGetRequestStatus).not.toHaveBeenCalled();
      expect(mockSyncHealthKitToServer).not.toHaveBeenCalled();
    });

    it("catches HealthKit sync failure silently", async () => {
      mockSyncHealthKitToServer.mockRejectedValue(new Error("hk error"));

      renderHook(() => useAutoSync("2026-03-21"));
      await act(() => vi.runAllTimersAsync());

      // Should not throw — failure is silently caught
      expect(mockSyncHealthKitToServer).toHaveBeenCalled();
    });
  });
});
