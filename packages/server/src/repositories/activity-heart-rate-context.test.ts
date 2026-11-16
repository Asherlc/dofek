import { describe, expect, it, vi } from "vitest";
import { getActivityHeartRateContext } from "./activity-heart-rate-context.ts";
import { activityMetricWindow as window } from "./activity-metric-source-test-helpers.ts";

describe("activity heart-rate context", () => {
  it("requests five minutes around the activity using the selected HR source", async () => {
    const getStream = vi.fn().mockResolvedValue([
      { recorded_at: "2026-10-20T11:55:00.000Z", heart_rate: 90 },
      { recorded_at: "2026-10-20T13:05:00.000Z", heart_rate: 100 },
    ]);
    const result = await getActivityHeartRateContext({ getStream }, window, 500, "whoop");
    expect(result).toEqual({
      window: { startedAt: "2026-10-20T11:55:00.000Z", endedAt: "2026-10-20T13:05:00.000Z" },
      points: [
        { recordedAt: "2026-10-20T11:55:00.000Z", value: 90 },
        { recordedAt: "2026-10-20T13:05:00.000Z", value: 100 },
      ],
    });
    expect(getStream).toHaveBeenCalledWith({ ...window, ...result.window }, 500, {
      heartRate: "whoop",
    });
    expect(window.startedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(window.endedAt).toBe("2026-10-20T13:00:00.000Z");
  });

  it("does not invent an end for an open session or HR when no source exists", async () => {
    const getStream = vi.fn();
    const result = await getActivityHeartRateContext(
      { getStream },
      { ...window, endedAt: null },
      500,
      undefined,
    );
    expect(result.window).toEqual({ startedAt: "2026-10-20T11:55:00.000Z", endedAt: null });
    expect(result.points).toEqual([]);
    expect(getStream).not.toHaveBeenCalled();
  });

  it("filters stream points without a heart-rate measurement", async () => {
    const getStream = vi.fn().mockResolvedValue([
      { recorded_at: "2026-10-20T12:10:00.000Z", heart_rate: null },
      { recorded_at: "2026-10-20T12:11:00.000Z", heart_rate: 120 },
    ]);

    const result = await getActivityHeartRateContext({ getStream }, window, 500, "whoop");

    expect(result.points).toEqual([{ recordedAt: "2026-10-20T12:11:00.000Z", value: 120 }]);
  });
});
