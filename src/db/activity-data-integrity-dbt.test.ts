import { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: vi.fn(),
}));

describe("runActivityIntegrityDbtBuild", () => {
  it("rebuilds sensor membership before sensor and activity summaries", async () => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const build = runActivityIntegrityDbtBuild({
      userId: "00000000-0000-4000-8000-000000000001",
      activityIds: ["00000000-0000-4000-8000-000000000002"],
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
    const selection = args[args.indexOf("--select") + 1] ?? "";

    expect(selection).toContain(
      "deduped_activity_members activity_sensor_sample activity_sensor_summary_rows",
    );
    child.emit("close", 0);
    await expect(build).resolves.toBeUndefined();
  });
});
