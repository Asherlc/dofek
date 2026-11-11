import { activityChartSeries } from "@dofek/training/activity-chart-series";
import { act, renderHook } from "@testing-library/react";
import type {
  GestureResponderEvent,
  PanResponderCallbacks,
  PanResponderGestureState,
} from "react-native";
import { describe, expect, it, vi } from "vitest";
import { useChartScrub } from "./useChartScrub";

const native = vi.hoisted(() => {
  const callbacks: PanResponderCallbacks = {};
  return { callbacks };
});
vi.mock("react-native", () => ({
  PanResponder: {
    create: (callbacks: PanResponderCallbacks) => {
      native.callbacks = callbacks;
      return { panHandlers: {} };
    },
  },
}));

const startedAt = Date.parse("2026-10-20T16:00:00Z");
function recording(seconds: number[]) {
  return activityChartSeries(
    seconds.map((second) => ({
      recordedAt: new Date(startedAt + second * 1000).toISOString(),
      value: 130,
    })),
  );
}
function touch(locationX: number) {
  const event: GestureResponderEvent = {
    nativeEvent: {
      changedTouches: [],
      touches: [],
      identifier: 0,
      locationX,
      locationY: 0,
      pageX: locationX,
      pageY: 0,
      target: 1,
      timestamp: 0,
    },
    bubbles: false,
    cancelable: true,
    currentTarget: 1,
    target: 1,
    defaultPrevented: false,
    dispatchConfig: { registrationName: "onResponderGrant" },
    eventPhase: 0,
    isTrusted: true,
    timeStamp: 0,
    type: "touchstart",
    preventDefault: vi.fn(),
    isDefaultPrevented: () => false,
    stopPropagation: vi.fn(),
    isPropagationStopped: () => false,
    persist: vi.fn(),
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 0,
      numberActiveTouches: 1,
      touchBank: [],
    },
  };
  const gesture: PanResponderGestureState = {
    stateID: 1,
    moveX: locationX,
    moveY: 0,
    x0: locationX,
    y0: 0,
    dx: 0,
    dy: 0,
    vx: 0,
    vy: 0,
    numberActiveTouches: 1,
  };
  native.callbacks.onPanResponderGrant?.(event, gesture);
  return { event, gesture };
}

describe("useChartScrub", () => {
  it("reports the touched time independently of the nearest sample and clears it on release", () => {
    const onHoverTime = vi.fn();
    renderHook(() => useChartScrub({ plotWidth: 280, series: recording([0, 60]), onHoverTime }));
    act(() => {
      const { event, gesture } = touch(184);
      expect(onHoverTime).toHaveBeenLastCalledWith(startedAt + 30000);
      native.callbacks.onPanResponderRelease?.(event, gesture);
    });
    expect(onHoverTime).toHaveBeenLastCalledWith(null);
  });
  it("selects the measured sample nearest the touched time", () => {
    const onHoverIndex = vi.fn();
    const { result } = renderHook(() =>
      useChartScrub({
        plotWidth: 280,
        series: recording([0, 1, 20]),
        onHoverIndex,
      }),
    );
    act(() => touch(114));
    expect(result.current.touchIndex).toBe(1);
    expect(onHoverIndex).toHaveBeenLastCalledWith(1);
  });

  it("uses the latest source data and callbacks after a rerender", () => {
    const firstHover = vi.fn();
    const nextHover = vi.fn();
    const { result, rerender } = renderHook(
      ({ series, onHoverIndex }) =>
        useChartScrub({
          plotWidth: 280,
          series,
          onHoverIndex,
        }),
      { initialProps: { series: recording([0, 1, 20]), onHoverIndex: firstHover } },
    );
    act(() => touch(114));
    rerender({ series: recording([0, 19, 20]), onHoverIndex: nextHover });
    act(() => touch(114));
    expect(result.current.touchIndex).toBe(0);
    expect(nextHover).toHaveBeenLastCalledWith(0);
    expect(firstHover).toHaveBeenCalledTimes(1);
  });

  it("retains the original timeline index when other metrics have intervening samples", () => {
    const series = activityChartSeries(
      [130, null, 140].map((value, second) => ({
        recordedAt: new Date(startedAt + second * 1000).toISOString(),
        value,
      })),
    );
    const onHoverIndex = vi.fn();
    renderHook(() => useChartScrub({ plotWidth: 280, series, onHoverIndex }));
    act(() => touch(324));
    expect(onHoverIndex).toHaveBeenLastCalledWith(2);
  });
});
