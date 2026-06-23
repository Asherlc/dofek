import { describe, expect, it } from "vitest";
import {
  appleHealthWorkoutLogicalKey,
  buildAppleHealthWorkoutIdentity,
  collectAppleHealthWorkoutIdentities,
} from "./workout-identity.ts";

describe("appleHealthWorkoutLogicalKey", () => {
  it("uses sync identifier when present", () => {
    const identity = buildAppleHealthWorkoutIdentity({
      syncIdentifier: "19016909441",
      startedAt: new Date("2026-06-22T00:00:50.000Z"),
      endedAt: new Date("2026-06-22T01:31:41.000Z"),
      sourceName: "Strava",
    });

    expect(appleHealthWorkoutLogicalKey(identity)).toBe("sync:19016909441");
  });

  it("falls back to time and source for direct recordings", () => {
    const startedAt = new Date("2026-06-22T00:00:50.000Z");
    const endedAt = new Date("2026-06-22T01:31:41.000Z");
    const identity = buildAppleHealthWorkoutIdentity({
      startedAt,
      endedAt,
      sourceName: "Asher's Apple Watch",
    });

    expect(appleHealthWorkoutLogicalKey(identity)).toBe(
      `time:${startedAt.toISOString()}:${endedAt.toISOString()}:Asher's Apple Watch`,
    );
  });

  it("deduplicates identities in a workout push batch", () => {
    const identities = collectAppleHealthWorkoutIdentities([
      {
        syncIdentifier: "19016909441",
        startedAt: new Date("2026-06-22T00:00:50.000Z"),
        endedAt: new Date("2026-06-22T01:31:41.000Z"),
        sourceName: "Strava",
      },
      {
        syncIdentifier: "19016909441",
        startedAt: new Date("2026-06-22T00:00:50.000Z"),
        endedAt: new Date("2026-06-22T01:31:41.000Z"),
        sourceName: "Strava",
      },
    ]);

    expect(identities).toHaveLength(1);
  });
});
