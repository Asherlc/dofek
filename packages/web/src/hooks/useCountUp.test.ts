/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountUp } from "./useCountUp.ts";

describe("useCountUp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock performance.now to align with fake timers
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    // Mock requestAnimationFrame to use synchronous scheduling
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      time += 16; // ~60fps
      setTimeout(() => cb(time), 0);
      return time;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((_id) => {
      // no-op for test
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns em dash initially when target is null", () => {
    const { result } = renderHook(() => useCountUp(null));
    expect(result.current).toBe("\u2014");
  });

  it("returns em dash initially when target is undefined", () => {
    const { result } = renderHook(() => useCountUp(undefined));
    expect(result.current).toBe("\u2014");
  });

  it("animates from 0 toward the target value", () => {
    const { result } = renderHook(() => useCountUp(100));

    // After first animation frame, value should start moving toward 100
    act(() => {
      vi.advanceTimersByTime(0);
    });

    // The initial frame should produce a small number
    const firstFrame = Number(result.current.replace(/,/g, ""));
    expect(firstFrame).toBeGreaterThanOrEqual(0);
  });

  it("reaches the target value after animation completes", () => {
    const { result } = renderHook(() => useCountUp(100, 800));

    // Run enough frames for the animation to complete (800ms at 16ms per frame = 50 frames)
    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    expect(result.current).toBe("100");
  });

  it("respects decimals parameter", () => {
    const { result } = renderHook(() => useCountUp(42.567, 800, 2));

    // Run enough frames for animation to complete
    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    expect(result.current).toBe("42.57");
  });

  it("returns 0 decimal format for integer targets", () => {
    const { result } = renderHook(() => useCountUp(50, 800, 0));

    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    expect(result.current).toBe("50");
  });

  it("resets to em dash when target changes to null", () => {
    const { result, rerender } = renderHook<string, { target: number | null }>(
      ({ target }) => useCountUp(target),
      {
        initialProps: { target: 100 },
      },
    );

    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    rerender({ target: null });

    expect(result.current).toBe("\u2014");
  });

  it("cancels animation on unmount", () => {
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const { unmount } = renderHook(() => useCountUp(100));

    act(() => {
      vi.advanceTimersByTime(16);
    });

    unmount();

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("handles target of 0", () => {
    const { result } = renderHook(() => useCountUp(0, 800));

    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    expect(result.current).toBe("0");
  });

  it("uses default duration of 800ms", () => {
    const { result } = renderHook(() => useCountUp(100));

    // Run enough frames to complete in 800ms
    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    expect(result.current).toBe("100");
  });

  it("formats large numbers with locale string (commas)", () => {
    const { result } = renderHook(() => useCountUp(10000, 800));

    act(() => {
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
      }
    });

    // toLocaleString on 10000 should produce "10,000" in en-US
    expect(result.current).toBe("10,000");
  });
});
