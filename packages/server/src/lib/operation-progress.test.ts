import { describe, expect, it, vi } from "vitest";
import { readOperationProgress } from "./operation-progress.ts";

describe("readOperationProgress", () => {
  it.each([
    ["waiting", "queued"],
    ["delayed", "queued"],
    ["active", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)("maps BullMQ %s state to %s", async (bullMqState, expectedStatus) => {
    const progress = await readOperationProgress({
      failedReason: "Deletion failed",
      getState: vi.fn().mockResolvedValue(bullMqState),
      progress: { percentage: 42, message: "Deleting records..." },
    });

    expect(progress).toEqual({
      status: expectedStatus,
      percentage: 42,
      message: bullMqState === "failed" ? "Deletion failed" : "Deleting records...",
    });
  });

  it("omits invalid progress values", async () => {
    const progress = await readOperationProgress({
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("active"),
      progress: { percentage: 101, message: 123 },
    });

    expect(progress).toEqual({ status: "running" });
  });

  it("uses a completion message when the job has no final progress message", async () => {
    const progress = await readOperationProgress({
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("completed"),
      progress: 100,
    });

    expect(progress).toEqual({
      status: "completed",
      percentage: 100,
      message: "Operation complete",
    });
  });
});
