/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAutoSyncInvalidationTargets,
  invalidateAutoSyncQueries,
  isDataStale,
} from "./useAutoSync";

type ActiveSync = { jobId: string };
type ActiveSyncsQuery = {
  data: ActiveSync[];
  isLoading: boolean;
  error: Error | null;
};
type ActiveSyncsQueryOptions = {
  enabled: boolean;
};
type TriggerSyncMutationOptions = {
  onSuccess?: () => void | Promise<void>;
};

const {
  mockActivityInvalidate,
  mockActiveSyncs,
  mockCalendarActivityOverviewInvalidate,
  mockCaptureException,
  mockDataHealthInvalidate,
  mockInvalidate,
  mockMutate,
  mockReadinessInvalidate,
  mockWeightOverviewInvalidate,
  mockUseQueryOptions,
  mockTriggerSyncMutationOptions,
} = vi.hoisted(() => {
  const mockActiveSyncs: ActiveSyncsQuery = {
    data: [],
    isLoading: false,
    error: null,
  };
  const mockUseQueryOptions: ActiveSyncsQueryOptions[] = [];
  const mockTriggerSyncMutationOptions: TriggerSyncMutationOptions[] = [];

  return {
    mockActivityInvalidate: vi.fn(),
    mockActiveSyncs,
    mockCalendarActivityOverviewInvalidate: vi.fn(),
    mockCaptureException: vi.fn(),
    mockDataHealthInvalidate: vi.fn(),
    mockInvalidate: vi.fn(),
    mockMutate: vi.fn(),
    mockReadinessInvalidate: vi.fn(),
    mockWeightOverviewInvalidate: vi.fn(),
    mockUseQueryOptions,
    mockTriggerSyncMutationOptions,
  };
});

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    sync: {
      triggerSync: {
        useMutation: (options?: TriggerSyncMutationOptions) => {
          mockTriggerSyncMutationOptions.push(options ?? {});
          return { mutate: mockMutate };
        },
      },
      activeSyncs: {
        useQuery: (_input: undefined, options: ActiveSyncsQueryOptions) => {
          mockUseQueryOptions.push(options);
          return mockActiveSyncs;
        },
      },
    },
    recovery: { readinessScore: { invalidate: mockReadinessInvalidate } },
    calendar: { activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate } },
    activity: { list: { invalidate: mockActivityInvalidate } },
    bodyAnalytics: { weightOverview: { invalidate: mockWeightOverviewInvalidate } },
    useUtils: () => ({
      invalidate: mockInvalidate,
      processing: { status: { invalidate: mockDataHealthInvalidate } },
      recovery: { readinessScore: { invalidate: mockReadinessInvalidate } },
      calendar: { activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate } },
      activity: { list: { invalidate: mockActivityInvalidate } },
      bodyAnalytics: { weightOverview: { invalidate: mockWeightOverviewInvalidate } },
    }),
  },
}));

const autoSyncAttemptStorageKey = "dofek.dashboard.autoSyncAttempt";

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
    sessionStorage.clear();
    mockActiveSyncs.data = [];
    mockActiveSyncs.isLoading = false;
    mockActiveSyncs.error = null;
    mockCaptureException.mockClear();
    mockActivityInvalidate.mockClear();
    mockCalendarActivityOverviewInvalidate.mockClear();
    mockDataHealthInvalidate.mockClear();
    mockInvalidate.mockClear();
    mockMutate.mockClear();
    mockReadinessInvalidate.mockClear();
    mockWeightOverviewInvalidate.mockClear();
    mockTriggerSyncMutationOptions.length = 0;
    mockUseQueryOptions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trigger another dashboard auto-sync after remounting on the same day", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    const firstRender = renderHook(() => useAutoSync("2026-03-21"));
    firstRender.unmount();
    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({ sinceDays: 1 });
  });

  it("triggers again when the calendar day changes for the same stale latest data date", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));
    expect(mockMutate).toHaveBeenCalledTimes(1);

    mockMutate.mockClear();
    vi.setSystemTime(new Date("2026-03-23T10:00:00"));

    renderHook(() => useAutoSync("2026-03-21"));

    expect(sessionStorage.getItem(autoSyncAttemptStorageKey)).toBe("2026-03-23:2026-03-21");
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({ sinceDays: 1 });
  });

  it("does not trigger when data is current", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-22"));

    expect(mockUseQueryOptions.at(-1)).toEqual({ enabled: false });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not trigger while active syncs are still loading", async () => {
    mockActiveSyncs.isLoading = true;
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockUseQueryOptions.at(-1)).toEqual({ enabled: true });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not trigger when active sync lookup fails", async () => {
    mockActiveSyncs.error = new Error(
      "Active syncs are temporarily unavailable. Please try again.",
    );
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("does not trigger when another sync is already active", async () => {
    mockActiveSyncs.data = [{ jobId: "sync-1" }];
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockUseQueryOptions.at(-1)).toEqual({ enabled: true });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("marks the latest synced data date and requests one day of sync history", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(sessionStorage.getItem(autoSyncAttemptStorageKey)).toBe("2026-03-22:2026-03-21");
    expect(mockMutate).toHaveBeenCalledWith({ sinceDays: 1 });
  });

  it("does not query or trigger when the same stale latest data date was already attempted", async () => {
    sessionStorage.setItem(autoSyncAttemptStorageKey, "2026-03-22:2026-03-21");
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockUseQueryOptions.at(-1)).toEqual({ enabled: false });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("can trigger again when the latest data date changes on the same day", async () => {
    sessionStorage.setItem(autoSyncAttemptStorageKey, "2026-03-22:2026-03-20");
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockUseQueryOptions.at(-1)).toEqual({ enabled: true });
    expect(sessionStorage.getItem(autoSyncAttemptStorageKey)).toBe("2026-03-22:2026-03-21");
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("uses an in-memory fallback when sessionStorage writes fail", async () => {
    const getItem = vi.fn<(key: string) => string | null>().mockReturnValue(null);
    const setItem = vi.fn<(key: string, value: string) => void>().mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const origDesc = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      value: {
        getItem,
        setItem,
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 0,
      },
      configurable: true,
      writable: true,
    });

    try {
      const { useAutoSync } = await import("./useAutoSync");

      const firstRender = renderHook(() => useAutoSync("2026-03-21"));
      firstRender.unmount();
      getItem.mockImplementation(() => {
        throw new Error("storage disabled");
      });
      renderHook(() => useAutoSync("2026-03-21"));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    } finally {
      if (origDesc) {
        Object.defineProperty(window, "sessionStorage", origDesc);
      }
    }
  });

  it("triggers after rerendering from current data to stale data", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    const hook = renderHook(({ latestDate }) => useAutoSync(latestDate), {
      initialProps: { latestDate: "2026-03-22" },
    });
    hook.rerender({ latestDate: "2026-03-21" });

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("invalidates dashboard health query families after provider sync succeeds", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));
    await mockTriggerSyncMutationOptions.at(-1)?.onSuccess?.();

    expect(mockReadinessInvalidate).toHaveBeenCalledOnce();
    expect(mockCalendarActivityOverviewInvalidate).toHaveBeenCalledOnce();
    expect(mockActivityInvalidate).toHaveBeenCalledOnce();
    expect(mockDataHealthInvalidate).toHaveBeenCalledOnce();
    expect(mockWeightOverviewInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("captures an exception when query invalidation fails after sync", async () => {
    const error = new Error("invalidation failed");
    mockReadinessInvalidate.mockRejectedValue(error);
    const { useAutoSync } = await import("./useAutoSync");

    renderHook(() => useAutoSync("2026-03-21"));
    const onSuccessPromise = mockTriggerSyncMutationOptions.at(-1)?.onSuccess?.();
    await vi.advanceTimersByTimeAsync(250);
    await onSuccessPromise;

    expect(mockReadinessInvalidate).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      context: "dashboard-auto-sync-invalidation",
    });
  });

  it("retries query invalidation once before reporting failure", async () => {
    const error = new Error("transient invalidation failure");
    mockReadinessInvalidate.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const trpcUtils = {
      recovery: { readinessScore: { invalidate: mockReadinessInvalidate } },
      calendar: { activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate } },
      activity: { list: { invalidate: mockActivityInvalidate } },
      processing: { status: { invalidate: mockDataHealthInvalidate } },
      bodyAnalytics: { weightOverview: { invalidate: mockWeightOverviewInvalidate } },
    };

    const invalidationPromise = invalidateAutoSyncQueries(trpcUtils);
    await vi.advanceTimersByTimeAsync(250);
    await invalidationPromise;

    expect(mockReadinessInvalidate).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(getAutoSyncInvalidationTargets(trpcUtils)).toHaveLength(5);
  });
});
