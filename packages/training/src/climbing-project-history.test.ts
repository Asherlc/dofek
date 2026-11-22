import { describe, expect, it } from "vitest";
import { climbingProjectHistorySchema } from "./climbing-project-history.ts";

const valid = {
  throughDate: "2026-11-13",
  sessionCount: 2,
  unsuccessfulSessionCount: 1,
  unknownSessionCount: 0,
  firstSend: { date: "2026-11-13", sessionCount: 2, method: null },
  methodFirstSend: { date: "2026-11-13", sessionCount: 2, method: "lead" },
  repeatBeforeFirstSend: false,
  earlierSessionsUnknown: false,
  days: [
    { date: "2026-11-09", outcome: "unsuccessful", method: null },
    { date: "2026-11-13", outcome: "send", method: "lead" },
  ],
};

describe("climbingProjectHistorySchema", () => {
  it("accepts a complete history", () => {
    expect(climbingProjectHistorySchema.parse(valid)).toEqual(valid);
  });

  it("requires a positive first-send session count and a known method milestone method", () => {
    expect(
      climbingProjectHistorySchema.safeParse({
        ...valid,
        firstSend: { ...valid.firstSend, sessionCount: 0 },
      }).success,
    ).toBe(false);
    expect(
      climbingProjectHistorySchema.safeParse({
        ...valid,
        methodFirstSend: { ...valid.methodFirstSend, method: null },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and invalid outcomes", () => {
    expect(climbingProjectHistorySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      climbingProjectHistorySchema.safeParse({
        ...valid,
        days: [{ date: "2026-11-09", outcome: "maybe", method: null }],
      }).success,
    ).toBe(false);
  });
});
