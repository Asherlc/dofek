/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("hello", 500));
    expect(result.current).toBe("hello");
  });

  it("updates after the delay", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) => useDebouncedValue(value, delay),
      { initialProps: { value: "hello", delay: 500 } },
    );

    rerender({ value: "world", delay: 500 });
    expect(result.current).toBe("hello");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe("world");
  });

  it("clears the timeout on unmount and does not update", () => {
    const { result, rerender, unmount } = renderHook(
      ({ value, delay }: { value: string; delay: number }) => useDebouncedValue(value, delay),
      { initialProps: { value: "hello", delay: 500 } },
    );

    rerender({ value: "world", delay: 500 });
    expect(result.current).toBe("hello");

    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe("hello");
  });

  it("uses cancelled flag to prevent stale updates when clearTimeout is unavailable", () => {
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ value, delay }: { value: string; delay: number }) => useDebouncedValue(value, delay),
      { initialProps: { value: "a", delay: 500 } },
    );

    rerender({ value: "b", delay: 200 });

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("b");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("b");
  });
});
