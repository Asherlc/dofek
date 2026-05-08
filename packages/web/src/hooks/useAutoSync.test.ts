/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDataStale } from "./useAutoSync";

type ActiveSync = { jobId: string };
type ActiveSyncsQuery = {
  data: ActiveSync[];
  isLoading: boolean;
};
type ActiveSyncsQueryOptions = {
  enabled: boolean;
};

const { mockActiveSyncs, mockCaptureException, mockMutate, mockUseQueryOptions } = vi.hoisted(
  () => {
    const mockActiveSyncs: ActiveSyncsQuery = {
      data: [],
      isLoading: false,
    };
    const mockUseQueryOptions: ActiveSyncsQueryOptions[] = [];

    return {
      mockActiveSyncs,
      mockCaptureException: vi.fn(),
      mockMutate: vi.fn(),
      mockUseQueryOptions,
    };
  },
);

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    sync: {
      triggerSync: {
        useMutation: () => ({ mutate: mockMutate }),
      },
      activeSyncs: {
        useQuery: (_input: undefined, options: ActiveSyncsQueryOptions) => {
          mockUseQueryOptions.push(options);
          return mockActiveSyncs;
        },
      },
    },
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
    mockCaptureException.mockClear();
    mockMutate.mockClear();
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
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const { useAutoSync } = await import("./useAutoSync");

    const firstRender = renderHook(() => useAutoSync("2026-03-21"));
    firstRender.unmount();
    getItem.mockImplementation(() => {
      throw new Error("storage disabled");
    });
    renderHook(() => useAutoSync("2026-03-21"));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("triggers after rerendering from current data to stale data", async () => {
    const { useAutoSync } = await import("./useAutoSync");

    const hook = renderHook(({ latestDate }) => useAutoSync(latestDate), {
      initialProps: { latestDate: "2026-03-22" },
    });
    hook.rerender({ latestDate: "2026-03-21" });

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });
});
