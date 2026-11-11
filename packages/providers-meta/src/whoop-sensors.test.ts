import { describe, expect, it } from "vitest";
import { whoopSensorRecordSchema } from "./whoop-sensors.ts";

describe("WHOOP sensor upload contract", () => {
  it("keeps capture identity and unknown device information without inventing a model", () => {
    const record = whoopSensorRecordSchema.parse({
      captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
      timestamp: "2026-10-30T12:00:00.000Z",
      frameHex: "aa".repeat(32),
      deviceInfo: {},
    });
    expect(record.deviceInfo).toEqual({});
    expect(record.captureId).toBe("1087b7ac-fc32-4c29-8b31-72e366dc974d");
  });

  it.each(["a", "zz", "aa".repeat(65_544)])(
    "rejects malformed or oversized frame encoding",
    (frameHex) => {
      expect(
        whoopSensorRecordSchema.safeParse({
          captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
          timestamp: "2026-10-30T12:00:00.000Z",
          frameHex,
          deviceInfo: {},
        }).success,
      ).toBe(false);
    },
  );
});
