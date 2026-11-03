import { describe, expect, it } from "vitest";
import { SyncWindow } from "../sync-window.ts";
import { StravaSyncCheckpoint } from "./sync-checkpoint.ts";
import { createMemoryCheckpointStore } from "./test-helpers.ts";

const window = SyncWindow.fromIsoRange({
  sinceIso: "2026-01-01T00:00:00.000Z",
  untilIso: "2026-04-01T00:00:00.000Z",
});

describe("StravaSyncCheckpoint", () => {
  it("restores committed progress from durable storage across new instances", async () => {
    const store = createMemoryCheckpointStore();
    const first = await StravaSyncCheckpoint.load(window, store);
    await first.completeActivity("123");
    const resumed = await StravaSyncCheckpoint.load(window, store);
    expect([...resumed.completedActivityExternalIds]).toEqual(["123"]);
    await resumed.clear();
    const next = await StravaSyncCheckpoint.load(window, store);
    expect(next.completedActivityExternalIds.size).toBe(0);
  });

  it.each([
    { version: 2 },
    { untilIso: "invalid" },
    { completedActivityExternalIds: null },
    { completedActivityExternalIds: [123] },
    { completedActivityExternalIds: ["not-an-id"] },
    { sinceIso: "invalid" },
  ])("rejects malformed durable state: %j", async (invalid) => {
    const store = createMemoryCheckpointStore({
      version: 1,
      sinceIso: window.sinceIso,
      untilIso: window.untilIso,
      completedActivityExternalIds: [],
      ...invalid,
    });
    await expect(StravaSyncCheckpoint.load(window, store)).rejects.toThrow(
      "Invalid Strava sync checkpoint",
    );
  });
});
