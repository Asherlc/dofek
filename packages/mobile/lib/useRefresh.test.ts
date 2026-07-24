// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvalidate = vi.fn(() => Promise.resolve());
const mockActivityListInvalidate = vi.fn(() => Promise.resolve());
const mockCalendarActivityOverviewInvalidate = vi.fn(() => Promise.resolve());
const mockCalendarWeekListInvalidate = vi.fn(() => Promise.resolve());
const mockDashboardInvalidate = vi.fn(() => Promise.resolve());
const mockDataHealthInvalidate = vi.fn(() => Promise.resolve());
const mockFoodByDateInvalidate = vi.fn(() => Promise.resolve());
const mockNutritionAnalyticsAdaptiveTdeeInvalidate = vi.fn(() => Promise.resolve());
const mockNutritionAnalyticsMacroRatiosInvalidate = vi.fn(() => Promise.resolve());
const mockNutritionAnalyticsMicronutrientAdequacyInvalidate = vi.fn(() => Promise.resolve());
const mockRecoveryInvalidate = vi.fn(() => Promise.resolve());
const mockTrainingInvalidate = vi.fn(() => Promise.resolve());

vi.mock("./trpc", () => ({
  trpc: {
    useUtils: () => ({
      invalidate: mockInvalidate,
      mobileDashboard: {
        dashboard: { invalidate: mockDashboardInvalidate },
        recovery: { invalidate: mockRecoveryInvalidate },
        training: { invalidate: mockTrainingInvalidate },
      },
      calendar: {
        weekList: { invalidate: mockCalendarWeekListInvalidate },
        activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate },
      },
      activity: { list: { invalidate: mockActivityListInvalidate } },
      food: { byDate: { invalidate: mockFoodByDateInvalidate } },
      processing: { status: { invalidate: mockDataHealthInvalidate } },
      nutritionAnalytics: {
        adaptiveTdee: { invalidate: mockNutritionAnalyticsAdaptiveTdeeInvalidate },
        macroRatios: { invalidate: mockNutritionAnalyticsMacroRatiosInvalidate },
        micronutrientAdequacy: {
          invalidate: mockNutritionAnalyticsMicronutrientAdequacyInvalidate,
        },
      },
    }),
  },
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
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

  it("stops refreshing after invalidation starts without waiting for refetches", async () => {
    let resolveInvalidate: () => void = () => {};
    mockInvalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInvalidate = resolve;
        }),
    );

    const { result } = renderHook(() => useRefresh());
    let refreshCompletion = Promise.resolve();

    await act(async () => {
      refreshCompletion = Promise.resolve(result.current.onRefresh());
      await Promise.resolve();
    });

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(result.current.refreshing).toBe(false);

    resolveInvalidate();
    await act(async () => {
      await refreshCompletion;
    });
  });

  it("uses a scoped refresh callback without globally invalidating when invalidation is disabled", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useRefresh({ refresh, invalidate: null }));

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(result.current.refreshing).toBe(false);
  });

  it("resets refreshing to false even if invalidate rejects", async () => {
    const error = new Error("network error");
    mockInvalidate.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useRefresh());

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(result.current.refreshing).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledWith(error, { source: "useRefresh.invalidate" });
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

  it("calls captureException when extra callback rejects", async () => {
    const extraError = new Error("extra failed");
    const extra = vi.fn(() => Promise.reject(extraError));
    const { result } = renderHook(() => useRefresh(extra));

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(mockCaptureException).toHaveBeenCalledWith(extraError, { source: "useRefresh" });
  });
});
