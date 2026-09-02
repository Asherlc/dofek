import { describe, expect, it } from "vitest";
import type { ParsedFitRecord } from "./parser.ts";
import { fitRecordsToSensorSamples } from "./records.ts";

describe("fitRecordsToSensorSamples", () => {
  it("converts raw FIT metadata to JSON-compatible values", () => {
    const recordedAt = new Date("2026-01-19T12:58:55.000Z");
    const calibrationTime = new Date("2026-01-19T12:58:00.000Z");
    const record = {
      recordedAt,
      heartRate: 90,
      raw: {
        timestamp: recordedAt,
        nested: {
          calibration_time: calibrationTime,
        },
        samples: [recordedAt, 245],
      },
    } satisfies ParsedFitRecord;

    const [row] = fitRecordsToSensorSamples([record], "wahoo", "activity-1", null);

    expect(row?.raw).toEqual({
      timestamp: "2026-01-19T12:58:55.000Z",
      nested: {
        calibration_time: "2026-01-19T12:58:00.000Z",
      },
      samples: ["2026-01-19T12:58:55.000Z", 245],
    });
  });

  it("preserves scalar metadata and converts nullish parser values safely", () => {
    const record = {
      recordedAt: new Date("2026-01-19T12:58:55.000Z"),
      raw: {
        device_name: "Edge 1050",
        is_indoor: true,
        missing_value: undefined,
        null_value: null,
      },
    } satisfies ParsedFitRecord;

    const [row] = fitRecordsToSensorSamples([record], "wahoo", "activity-1", null);

    expect(row?.raw).toEqual({
      device_name: "Edge 1050",
      is_indoor: true,
      missing_value: null,
      null_value: null,
    });
  });
});
