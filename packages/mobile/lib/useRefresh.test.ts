// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvalidate = vi.fn(() => Promise.resolve());

vi.mock("./trpc", () => ({
  trpc: {
    useUtils: () => ({ invalidate: mockInvalidate }),
  },
}));

// Import after mock setup
const { useRefresh } = await import("./useRefresh");

describe("useRefresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts with refreshing = false", () => {
    const { result } = renderHook(() => useRefresh());
    expect(result.current.refreshing).toBe(false);
  });

  it("sets refreshing to true during refresh, then false after", async () => {
    const { result } = renderHook(() => useRefresh());

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(result.current.refreshing).toBe(false);
  });

  it("resets refreshing to false even if invalidate rejects", async () => {
    mockInvalidate.mockRejectedValueOnce(new Error("network error"));

    const { result } = renderHook(() => useRefresh());

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(result.current.refreshing).toBe(false);
  });

  it("calls the extra callback alongside invalidate", async () => {
    const extra = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useRefresh(extra));

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(extra).toHaveBeenCalledOnce();
  });

  it("resets refreshing even if the extra callback rejects", async () => {
    const extra = vi.fn(() => Promise.reject(new Error("sync failed")));
    const { result } = renderHook(() => useRefresh(extra));

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(result.current.refreshing).toBe(false);
  });
});
