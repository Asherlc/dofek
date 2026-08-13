// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mutable mock state ---
const mockMutateAsync = vi.fn();
const mockInvalidate = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockQueryClient = {};
const mockInvalidateSyncedHealthData = vi.fn();
let mockActiveSyncs: {
  data: unknown[] | undefined;
  isLoading: boolean;
  error: Error | null;
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...original,
    useQueryClient: () => mockQueryClient,
  };
});

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
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockRequestPermissions = vi.fn().mockResolvedValue(true);

vi.mock("../modules/health-kit", async () => {
  const { createEmptyAnchoredQueryResult } = await import("../modules/health-kit/test-helpers");
  return {
    completeAnchoredQuery: vi.fn().mockResolvedValue(true),
    isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
    hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
    getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
    requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
    queryAnchoredSamples: vi.fn().mockResolvedValue(createEmptyAnchoredQueryResult()),
    queryDailyStatistics: vi.fn(),
    queryQuantitySamples: vi.fn(),
    queryWorkouts: vi.fn(),
    querySleepSamples: vi.fn(),
    queryWorkoutRoutes: vi.fn(),
    deleteDietarySamples: vi.fn(),
  };
});

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

vi.mock("./invalidate-synced-health-data", () => ({
  invalidateSyncedHealthData: (...args: unknown[]) => mockInvalidateSyncedHealthData(...args),
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
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T10:00:00"));
    mockActiveSyncs = { data: [], isLoading: false, error: null };
    mockMutateAsync.mockResolvedValue({ jobId: "test-job" });
    mockSyncStatusFetch.mockResolvedValue({ status: "completed" });
    mockIsAvailable.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("unnecessary");
    mockRequestPermissions.mockResolvedValue(true);
    mockInvalidateSyncedHealthData.mockResolvedValue(undefined);
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

  it("does not trigger when active sync lookup fails", async () => {
    mockActiveSyncs.error = new Error(
      "Active syncs are temporarily unavailable. Please try again.",
    );

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("triggers sync and invalidates affected query families when job completes", async () => {
    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalledWith({ sinceDays: 1 });
    expect(mockSyncStatusFetch).toHaveBeenCalledWith({ jobId: "test-job" }, { staleTime: 0 });
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledWith(mockQueryClient);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("continues status polling when the mutation result rerenders while pending", async () => {
    let resolveTriggerSync: ((result: { jobId: string }) => void) | undefined;
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTriggerSync = resolve;
        }),
    );

    const rendered = renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mockMutateAsync).toHaveBeenCalledOnce();

    rendered.rerender();
    await act(async () => {
      resolveTriggerSync?.({ jobId: "test-job" });
      await vi.runAllTimersAsync();
    });

    expect(mockSyncStatusFetch).toHaveBeenCalledOnce();
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
  });

  it("continues status polling when active sync data changes while the trigger is pending", async () => {
    let resolveTriggerSync: ((result: { jobId: string }) => void) | undefined;
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTriggerSync = resolve;
        }),
    );

    const rendered = renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mockMutateAsync).toHaveBeenCalledOnce();

    mockActiveSyncs.data = [];
    rendered.rerender();
    await act(async () => {
      resolveTriggerSync?.({ jobId: "test-job" });
      await vi.runAllTimersAsync();
    });

    expect(mockSyncStatusFetch).toHaveBeenCalledOnce();
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
  });

  it("polls multiple times before completing", async () => {
    mockSyncStatusFetch
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "completed" });

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(3);
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalled();
  });

  it("retries sync status after a transient server error", async () => {
    const statusError = new Error("Sync status is temporarily unavailable. Please try again.");
    mockSyncStatusFetch
      .mockRejectedValueOnce(statusError)
      .mockResolvedValueOnce({ status: "completed" });

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).toHaveBeenCalledWith(statusError, {
      source: "auto-sync-status",
    });
    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
  });

  it("stops retrying sync status when unmounted during the retry delay", async () => {
    const statusError = new Error("Sync status is temporarily unavailable. Please try again.");
    mockSyncStatusFetch
      .mockRejectedValueOnce(statusError)
      .mockResolvedValueOnce({ status: "completed" });

    const rendered = renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);

    rendered.unmount();
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);
  });

  it("invalidates affected query families on error status", async () => {
    mockSyncStatusFetch.mockResolvedValue({ status: "failed" });

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("invalidates affected query families when syncStatus returns null", async () => {
    mockSyncStatusFetch.mockResolvedValue(null);

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("catches sync failure and calls captureException", async () => {
    const syncError = new Error("network error");
    mockMutateAsync.mockRejectedValue(syncError);

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockMutateAsync).toHaveBeenCalled();
    expect(mockInvalidateSyncedHealthData).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
      source: "auto-sync-providers",
    });
  });

  it("reports synchronized-health invalidation failures", async () => {
    const invalidateError = new Error("invalidate failed");
    mockInvalidateSyncedHealthData.mockRejectedValue(invalidateError);

    renderHook(() => useAutoSync("2026-03-21"));
    await act(() => vi.runAllTimersAsync());

    expect(mockCaptureException).toHaveBeenCalledWith(invalidateError, {
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
});
