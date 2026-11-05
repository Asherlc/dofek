import { describe, expect, it } from "vitest";
import { sourcePlacementSchema } from "./source-placement.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const placement = {
  sourceId: "00000000-0000-4000-8000-000000000002",
  userId,
  providerId: "test",
  sourceVersion: "9007199254740993",
  generation: "0",
  key: { userId, channel: "heart_rate", recordedAt: "2026-11-03T00:00:00.123456789Z" },
  activityId: null,
  deleted: false,
};
describe("source placement", () => {
  it("preservesTimestampAndSourceVersionPrecision", () => {
    expect(sourcePlacementSchema.parse(placement)).toEqual(placement);
    const microseconds = {
      ...placement,
      key: { ...placement.key, recordedAt: "2026-11-03T00:00:00.123456Z" },
    };
    expect(sourcePlacementSchema.parse(microseconds)).toEqual(microseconds);
  });
  it("rejectsAKeyOwnedByAnotherAccount", () => {
    expect(() =>
      sourcePlacementSchema.parse({
        ...placement,
        key: { ...placement.key, userId: placement.sourceId },
      }),
    ).toThrow(/owner/i);
  });
});
