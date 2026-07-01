import { describe, expect, it } from "vitest";
import {
  createWhoopSyncCheckpoint,
  parseWhoopSyncCheckpoint,
  WHOOP_CYCLE_WINDOW_MS,
  type WhoopSyncCheckpoint,
} from "./sync-checkpoint.ts";

const validCheckpoint: WhoopSyncCheckpoint = {
  runId: "run-1",
  recordsSynced: 3,
  phase: "api",
  cycleFetchCursorMs: 1_700_000_000_000,
  cycles: [{ id: 1 }],
  apiSteps: [
    { type: "strain_deep_dive", date: "2026-03-01" },
    { type: "sleep_stages", sleepId: "sleep-1" },
  ],
  apiStepIndex: 0,
  presentExternalIds: ["workout-1"],
  developerWorkoutPaginationComplete: false,
};

describe("WHOOP sync checkpoint", () => {
  it("uses a 200-day cycle fetch window", () => {
    expect(WHOOP_CYCLE_WINDOW_MS).toBe(200 * 24 * 60 * 60 * 1000);
  });

  it("creates a bootstrap checkpoint with empty collections", () => {
    const windowStartMs = 1_704_067_200_000;
    const checkpoint = createWhoopSyncCheckpoint(windowStartMs);

    expect(checkpoint.phase).toBe("bootstrap");
    expect(checkpoint.cycleFetchCursorMs).toBe(windowStartMs);
    expect(checkpoint.cycles).toEqual([]);
    expect(checkpoint.apiSteps).toEqual([]);
    expect(checkpoint.presentExternalIds).toEqual([]);
    expect(checkpoint.developerWorkoutPaginationComplete).toBe(false);
    expect(checkpoint.apiStepIndex).toBe(0);
    expect(checkpoint.recordsSynced).toBe(0);
    expect(checkpoint.runId.length).toBeGreaterThan(0);
  });

  it("parses a valid checkpoint payload", () => {
    expect(parseWhoopSyncCheckpoint(validCheckpoint)).toEqual(validCheckpoint);
  });

  it("applies schema defaults for omitted checkpoint fields", () => {
    const parsed = parseWhoopSyncCheckpoint({
      runId: "run-2",
      phase: "bootstrap",
      cycleFetchCursorMs: 1,
    });

    expect(parsed).toEqual({
      runId: "run-2",
      recordsSynced: 0,
      phase: "bootstrap",
      cycleFetchCursorMs: 1,
      cycles: [],
      apiSteps: [],
      apiStepIndex: 0,
      presentExternalIds: [],
      developerWorkoutPaginationComplete: false,
    });
    expect(parsed?.developerWorkoutPaginationComplete).toBe(false);
  });

  it("preserves completed developer workout pagination state", () => {
    expect(
      parseWhoopSyncCheckpoint({
        ...validCheckpoint,
        developerWorkoutPaginationComplete: true,
      })?.developerWorkoutPaginationComplete,
    ).toBe(true);
  });

  it("returns null for invalid checkpoint payloads", () => {
    expect(parseWhoopSyncCheckpoint(null)).toBeNull();
    expect(parseWhoopSyncCheckpoint({})).toBeNull();
    expect(parseWhoopSyncCheckpoint({ ...validCheckpoint, phase: "invalid" })).toBeNull();
    expect(
      parseWhoopSyncCheckpoint({
        ...validCheckpoint,
        apiSteps: [{ type: "unknown_step" }],
      }),
    ).toBeNull();
    expect(
      parseWhoopSyncCheckpoint({
        ...validCheckpoint,
        cycles: ["not-a-cycle"],
      }),
    ).toBeNull();
    expect(
      parseWhoopSyncCheckpoint({
        ...validCheckpoint,
        cycles: [null],
      }),
    ).toBeNull();
  });
});
