/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDataStale } from "./useAutoSync";

type ActiveSync = { jobId: string };
type ActiveSyncsQuery = {
  data: ActiveSync[];
  isLoading: boolean;
};

const { mockActiveSyncs, mockMutate } = vi.hoisted(() => {
  const mockActiveSyncs: ActiveSyncsQuery = {
    data: [],
    isLoading: false,
  };

  return {
    mockActiveSyncs,
    mockMutate: vi.fn(),
  };
});

vi.mock("../lib/trpc", () => ({
  trpc: {
    sync: {
      triggerSync: {
        useMutation: () => ({ mutate: mockMutate }),
      },
      activeSyncs: {
        useQuery: () => mockActiveSyncs,
      },
    },
  },
}));

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
    mockMutate.mockClear();
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
  });
});
