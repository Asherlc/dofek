/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTodayQueryDate } from "./useTodayQueryDate.ts";

describe("useTodayQueryDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns today's date in UTC initially", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00.000Z"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");
  });

  it("rolls over after UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T23:59:58.000Z"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");

    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(result.current).toBe("2026-03-22");
  });
});
