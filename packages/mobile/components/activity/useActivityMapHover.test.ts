import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActivityMapHover } from "./useActivityMapHover";

const points = [
  { recordedAt: "2026-10-30T12:00:00Z", lat: 0, lng: 1 },
  { recordedAt: "2026-10-30T12:01:00Z", lat: 2, lng: 3 },
] as const;

describe("useActivityMapHover", () => {
  it("maps context timestamps to recorded positions rather than context row indices", () => {
    const { result } = renderHook(() => useActivityMapHover(points));
    act(() => result.current.handleHoverTime(Date.parse("2026-10-30T12:00:55Z")));
    expect(result.current.hoveredPosition).toEqual({ lat: 2, lng: 3 });
    act(() => result.current.handleHoverIndex(0));
    expect(result.current.hoveredPosition).toEqual({ lat: 0, lng: 1 });
  });

  it.each([null, "2026-10-30T11:59:59Z", "2026-10-30T12:01:01Z"])(
    "clears map hover outside the recorded timeline: %s",
    (time) => {
      const { result } = renderHook(() => useActivityMapHover(points));
      act(() => result.current.handleHoverIndex(1));
      act(() => result.current.handleHoverTime(time === null ? null : Date.parse(time)));
      expect(result.current.hoveredPosition).toBeNull();
    },
  );

  it("clears hover for missing coordinates and empty streams", () => {
    const { result } = renderHook(() =>
      useActivityMapHover([{ ...points[0], lat: null, lng: null }]),
    );
    act(() => result.current.handleHoverIndex(0));
    expect(result.current.hoveredPosition).toBeNull();
    const empty = renderHook(() => useActivityMapHover([]));
    act(() => empty.result.current.handleHoverTime(Date.parse(points[0].recordedAt)));
    expect(empty.result.current.hoveredPosition).toBeNull();
  });
});
