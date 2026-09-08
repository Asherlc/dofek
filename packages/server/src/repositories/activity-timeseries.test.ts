import { describe, expect, it } from "vitest";
import { synchronizeActivityTimeseries } from "./activity-timeseries.ts";

const startedAt = "2026-09-01T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();

describe("synchronizeActivityTimeseries", () => {
  it("preserves measured zero while marking independently missing raw streams", () => {
    const result = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(4),
      streams: ["power", "heart_rate"],
      resolution: "raw",
      fill: "none",
      samples: [
        { recordedAt: at(0), stream: "power", value: 0, sourceIndex: 0 },
        { recordedAt: at(1), stream: "heart_rate", value: 140, sourceIndex: 1 },
        { recordedAt: at(2), stream: "power", value: 200, sourceIndex: 0 },
      ],
    });

    expect(result).toMatchSnapshot();
    expect(result.timestamps).toEqual([at(0), at(1), at(2)]);
    expect(result.offsetsSeconds).toEqual([0, 1, 2]);
    expect(result.streams.power).toMatchObject({
      values: [0, null, 200],
      states: ["measured_zero", "missing", "measured"],
      sourceIndexes: [[0], null, [0]],
    });
    expect(result.streams.heart_rate).toMatchObject({
      values: [null, 140, null],
      states: ["missing", "measured", "missing"],
      sourceIndexes: [null, [1], null],
    });
  });

  it("uses elapsed-time weighting within a fixed scalar bucket", () => {
    const result = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(10),
      streams: ["power"],
      resolution: "5s",
      fill: "none",
      samples: [
        { recordedAt: at(0), stream: "power", value: 100, sourceIndex: 0 },
        { recordedAt: at(1), stream: "power", value: 200, sourceIndex: 1 },
        { recordedAt: at(4), stream: "power", value: 300, sourceIndex: 2 },
      ],
    });

    expect(result).toMatchSnapshot();
    expect(result.timestamps).toEqual([at(0), at(5)]);
    expect(result).toMatchSnapshot();
    expect(result.streams.power).toMatchObject({
      values: [200, null],
      states: ["aggregated", "missing"],
      sourceIndexes: [[0, 1, 2], null],
    });
  });

  it("linearly fills only a gap bounded by scalar observations", () => {
    const result = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(4),
      streams: ["power"],
      resolution: "1s",
      fill: "linear",
      samples: [
        { recordedAt: at(0), stream: "power", value: 0, sourceIndex: 0 },
        { recordedAt: at(2), stream: "power", value: 200, sourceIndex: 0 },
      ],
    });

    expect(result.streams.power).toMatchObject({
      values: [0, 100, 200, null],
      states: ["aggregated_zero", "interpolated", "aggregated", "missing"],
      sourceIndexes: [[0], null, [0], null],
    });
  });

  it("uses final cumulative distance and latest complete GPS pair per bucket", () => {
    const result = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(5),
      streams: ["distance", "position"],
      resolution: "5s",
      fill: "none",
      samples: [
        { recordedAt: at(0), stream: "distance", value: 0, sourceIndex: 0 },
        { recordedAt: at(2), stream: "distance", value: 20, sourceIndex: 0 },
        { recordedAt: at(1), stream: "position", value: [-122.1, 37.1], sourceIndex: 1 },
        { recordedAt: at(4), stream: "position", value: [-122.2, 37.2], sourceIndex: 1 },
      ],
    });

    expect(result).toMatchSnapshot();
    expect(result.streams.distance).toMatchObject({
      values: [20],
      states: ["aggregated"],
      sourceIndexes: [[0]],
    });
    expect(result.streams.position).toMatchObject({
      values: [[-122.2, 37.2]],
      states: ["aggregated"],
      sourceIndexes: [[1]],
    });
  });

  it("calculates moving time only when speed observations support it", () => {
    const available = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(4),
      streams: ["speed", "moving_time"],
      resolution: "raw",
      fill: "none",
      samples: [
        { recordedAt: at(0), stream: "speed", value: 2, sourceIndex: 0 },
        { recordedAt: at(1), stream: "speed", value: 2, sourceIndex: 0 },
        { recordedAt: at(2), stream: "speed", value: 0, sourceIndex: 0 },
        { recordedAt: at(3), stream: "speed", value: 0, sourceIndex: 0 },
      ],
    });
    expect(available).toMatchSnapshot();
    expect(available.streams.moving_time).toMatchObject({
      values: [0, 1, 2, 2],
      states: ["calculated_zero", "calculated", "calculated", "calculated"],
      sourceIndexes: [[0], [0], [0], [0]],
      availabilityReason: null,
    });

    const laterPage = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(4),
      rangeStartedAt: at(2),
      streams: ["speed", "moving_time"],
      resolution: "raw",
      fill: "none",
      samples: [
        { recordedAt: at(0), stream: "speed", value: 2, sourceIndex: 0 },
        { recordedAt: at(1), stream: "speed", value: 2, sourceIndex: 0 },
        { recordedAt: at(2), stream: "speed", value: 0, sourceIndex: 0 },
        { recordedAt: at(3), stream: "speed", value: 0, sourceIndex: 0 },
      ],
    });
    expect(laterPage).toMatchSnapshot();
    expect(laterPage.timestamps).toEqual([at(2), at(3)]);
    expect(laterPage.streams.moving_time?.values).toEqual([2, 2]);

    const unavailable = synchronizeActivityTimeseries({
      startedAt,
      endedAt: at(2),
      streams: ["power", "moving_time"],
      resolution: "raw",
      fill: "none",
      samples: [{ recordedAt: at(0), stream: "power", value: 100, sourceIndex: 0 }],
    });
    expect(unavailable).toMatchSnapshot();
    expect(unavailable.streams.moving_time).toMatchObject({
      values: [null],
      states: ["missing"],
      availabilityReason: "Moving time requires provider-recorded moving time or speed samples.",
    });
  });
});
