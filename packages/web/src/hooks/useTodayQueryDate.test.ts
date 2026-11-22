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
    // 10:00 local on March 21 is 18:00 UTC on March 21 (Pacific) — UTC date is still the 21st
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-21");
  });

  it("rolls over after UTC midnight", async () => {
    vi.useFakeTimers();
    // 23:59:58 local on March 21 is 07:59:58 UTC on March 22 (Pacific) — UTC date is already the 22nd
    vi.setSystemTime(new Date("2026-03-21T23:59:58"));

    const { result } = renderHook(() => useTodayQueryDate());
    expect(result.current).toBe("2026-03-22");

    await act(() => vi.advanceTimersByTimeAsync(2_100));

    expect(result.current).toBe("2026-03-22");
  });
});
