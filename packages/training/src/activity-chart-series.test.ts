import { describe, expect, it } from "vitest";
import { activityChartSeries, nearestActivityChartSample } from "./activity-chart-series.ts";

const startedAt = Date.parse("2026-10-20T16:00:00Z");
function sample(second: number, value: number | null) {
  return { recordedAt: new Date(startedAt + second * 1000).toISOString(), value };
}

describe("activityChartSeries", () => {
  it.each([200, 500])(
    "keeps a continuous four-hour recording connected at %i returned points",
    (count) => {
      const series = activityChartSeries(
        Array.from({ length: count }, (_, index) =>
          sample((index * 4 * 60 * 60) / (count - 1), 130),
        ),
      );
      expect(series.samples.filter(({ startsSegment }) => startsSegment)).toHaveLength(1);
      expect(series.samples.filter(({ showMarker }) => showMarker)).toHaveLength(0);
    },
  );

  it("uses each metric's observations and retains the original indices", () => {
    const series = activityChartSeries([
      sample(0, 130),
      sample(1, null),
      sample(2, 135),
      sample(3, null),
      sample(4, 140),
    ]);
    expect(series.samples.map(({ index, startsSegment }) => [index, startsSegment])).toEqual([
      [0, true],
      [2, false],
      [4, false],
    ]);
  });

  it("positions irregular observations by time within the full activity timeline", () => {
    const series = activityChartSeries([sample(0, null), sample(1, 130), sample(4, 140)]);
    expect(series.samples.map(({ position }) => position)).toEqual([0.25, 1]);
    expect([series.startedAt, series.endedAt]).toEqual([startedAt, startedAt + 4000]);
  });

  it("preserves interruptions based on the metric's cadence", () => {
    const series = activityChartSeries([0, 1, 2, 20, 21].map((second) => sample(second, 130)));
    expect(series.samples.map(({ startsSegment }) => startsSegment)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it("allows timing variation up to the continuity boundary", () => {
    const series = activityChartSeries([0, 2, 5].map((second) => sample(second, 130)));
    expect(series.samples.map(({ startsSegment }) => startsSegment)).toEqual([true, false, false]);
  });

  it("does not infer a continuous recording from only two spot readings", () => {
    const series = activityChartSeries([sample(0, 130), sample(120, 145)]);
    expect(
      series.samples.map(({ startsSegment, showMarker }) => [startsSegment, showMarker]),
    ).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("keeps sparse observations visible while leaving dense segments uncluttered", () => {
    const dense = activityChartSeries(
      Array.from({ length: 40 }, (_, second) => sample(second, 130)),
    );
    expect(dense.samples.every(({ showMarker }) => !showMarker)).toBe(true);
    const sparse = activityChartSeries([sample(0, 130), sample(1, 135), sample(2, 140)]);
    expect(sparse.samples.every(({ showMarker }) => showMarker)).toBe(true);
  });

  it("marks an isolated observation even beside a dense segment", () => {
    const series = activityChartSeries([
      ...Array.from({ length: 40 }, (_, second) => sample(second, 130)),
      sample(120, 145),
    ]);
    expect(series.samples.at(-1)).toMatchObject({ startsSegment: true, showMarker: true });
    expect(series.samples[0]).toMatchObject({ showMarker: false });
  });

  it("preserves recorded zero, negative values, and duplicate observations", () => {
    const series = activityChartSeries([sample(0, 0), sample(0, 0), sample(1, -5)]);
    expect(series.samples.map(({ index, value }) => [index, value])).toEqual([
      [0, 0],
      [1, 0],
      [2, -5],
    ]);
  });

  it("keeps a single observation centered and visible", () => {
    const series = activityChartSeries([sample(0, 130)]);
    expect(series.samples[0]).toMatchObject({
      position: 0.5,
      showMarker: true,
      startsSegment: true,
    });
  });

  it("handles a metric with no observations", () => {
    expect(activityChartSeries([sample(0, null)]).samples).toEqual([]);
    expect(activityChartSeries([]).samples).toEqual([]);
  });
});

describe("nearestActivityChartSample", () => {
  it("finds a measurement by time and preserves its original timeline index", () => {
    const series = activityChartSeries([
      sample(0, 130),
      sample(1, null),
      sample(2, 135),
      sample(20, 140),
    ]);
    expect(nearestActivityChartSample(series.samples, startedAt + 6000)?.index).toBe(2);
    expect(nearestActivityChartSample(series.samples, startedAt - 1000)?.index).toBe(0);
    expect(nearestActivityChartSample(series.samples, startedAt + 30_000)?.index).toBe(3);
  });

  it("returns no observation for an empty series", () => {
    expect(nearestActivityChartSample([], startedAt)).toBeNull();
  });
});
