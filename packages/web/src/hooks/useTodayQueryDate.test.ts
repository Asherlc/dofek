/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMillisecondsUntilNextLocalMidnight, useTodayQueryDate } from "./useTodayQueryDate.ts";

describe("getMillisecondsUntilNextLocalMidnight", () => {
  it("returns the time remaining until just after local midnight", () => {
    const now = new Date("2026-03-21T23:59:50");
    expect(getMillisecondsUntilNextLocalMidnight(now)).toBe(10_050);
  });
});

describe("useTodayQueryDate", () => {
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
});
