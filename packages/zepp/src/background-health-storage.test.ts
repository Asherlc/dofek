import { describe, expect, it } from "vitest";
import { parseBackgroundHealthBuffer } from "./background-health-storage.ts";

describe("parseBackgroundHealthBuffer", () => {
  it("parses a persisted background buffer", () => {
    expect(
      parseBackgroundHealthBuffer(
        JSON.stringify({
          samples: [{ recordedAt: "2024-07-03T10:48:20.000Z", heartRate: 72 }],
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
      samples: [{ recordedAt: "2024-07-03T10:48:20.000Z", heartRate: 72 }],
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
});
