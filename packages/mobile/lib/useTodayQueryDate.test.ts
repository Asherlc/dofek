import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const appStateListeners: Array<(state: string) => void> = [];
  return {
    appStateListeners,
    remove: vi.fn(),
  };
});

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return { remove: mocks.remove };
    }),
  },
}));

import { useTodayQueryDate } from "./useTodayQueryDate";

describe("useTodayQueryDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appStateListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns today's date initially", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");
  });

  it("rolls over after local midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T23:59:58"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");

    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(result.current).toBe("2026-03-22");
  });

  it("refreshes when the app returns to the foreground and keeps the same date stable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");
    const appStateListener = mocks.appStateListeners.at(0);
    if (!appStateListener) throw new Error("Expected an AppState listener");

    await act(() => appStateListener("active"));
    expect(result.current).toBe("2026-03-21");

    vi.setSystemTime(new Date("2026-03-22T08:00:00"));
    await act(() => appStateListener("active"));
    expect(result.current).toBe("2026-03-22");
  });

  it("removes the AppState listener and clears the midnight timer on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T23:59:58"));
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = renderHook(() => useTodayQueryDate());
    unmount();

    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
