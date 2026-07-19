import { readFileSync, writeFileSync } from "@zos/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBackgroundHealthBuffer,
  readBackgroundHealthBuffer,
  writeBackgroundHealthBuffer,
} from "./background-health-storage.ts";

vi.mock("@zos/fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseBackgroundHealthBuffer", () => {
  it("parses a persisted background buffer", () => {
    expect(
      parseBackgroundHealthBuffer(
        JSON.stringify({
          samples: [
            {
              recordedAt: "2024-07-03T10:48:20.000Z",
              heartRate: 72,
              bloodOxygenPercent: 98,
              bodyTemperatureCelsius: 36.6,
              stress: 35,
            },
          ],
          activities: [
            {
              externalId: "1720000000",
              activityType: "other",
              startedAt: "2024-07-03T09:46:40.000Z",
              endedAt: "2024-07-03T10:46:40.000Z",
            },
          ],
        }),
      ),
    ).toEqual({
      samples: [
        {
          recordedAt: "2024-07-03T10:48:20.000Z",
          heartRate: 72,
          bloodOxygenPercent: 98,
          bodyTemperatureCelsius: 36.6,
          stress: 35,
        },
      ],
      activities: [
        {
          externalId: "1720000000",
          activityType: "other",
          startedAt: "2024-07-03T09:46:40.000Z",
          endedAt: "2024-07-03T10:46:40.000Z",
        },
      ],
    });
  });

  it("returns an empty buffer for malformed data", () => {
    expect(parseBackgroundHealthBuffer("not-json")).toEqual({ samples: [], activities: [] });
    expect(parseBackgroundHealthBuffer('{"samples":"invalid"}')).toEqual({
      samples: [],
      activities: [],
    });
  });

  it("filters malformed samples and activities", () => {
    expect(
      parseBackgroundHealthBuffer(
        JSON.stringify({
          samples: [null, {}, { recordedAt: 123 }, { recordedAt: "valid", heartRate: "72" }],
          activities: [
            null,
            {},
            { externalId: 1, activityType: "other", startedAt: "start", endedAt: "end" },
            { externalId: "id", activityType: "running", startedAt: "start", endedAt: "end" },
            { externalId: "id", activityType: "other", startedAt: 1, endedAt: "end" },
            { externalId: "id", activityType: "other", startedAt: "start", endedAt: 1 },
          ],
        }),
      ),
    ).toEqual({
      samples: [{ recordedAt: "valid", heartRate: undefined }],
      activities: [],
    });
  });

  it("reads, writes, and safely recovers from storage failures", () => {
    vi.mocked(readFileSync).mockReturnValueOnce('{"samples":[],"activities":[]}');
    expect(readBackgroundHealthBuffer()).toEqual({ samples: [], activities: [] });
    expect(readFileSync).toHaveBeenCalledWith({
      path: "data://health/background.json",
      options: { encoding: "utf8" },
    });

    vi.mocked(readFileSync).mockReturnValueOnce(new ArrayBuffer(0));
    expect(readBackgroundHealthBuffer()).toEqual({ samples: [], activities: [] });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(readBackgroundHealthBuffer()).toEqual({ samples: [], activities: [] });

    const buffer = { samples: [{ recordedAt: "now" }], activities: [] };
    writeBackgroundHealthBuffer(buffer);
    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://health/background.json",
      data: JSON.stringify(buffer),
    });
  });
});
