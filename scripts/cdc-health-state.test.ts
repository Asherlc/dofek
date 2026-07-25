import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const persistedStateSchema = z.object({
  consecutiveFailures: z.number().int().nonnegative(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  status: z.enum(["starting", "passing", "failing"]),
});

describe("cdc-health-state CLI", () => {
  let stateDirectory: string;
  let statePath: string;

  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), "dofek-cdc-health-cli-"));
    statePath = join(stateDirectory, "state.json");
  });

  afterEach(() => {
    rmSync(stateDirectory, { force: true, recursive: true });
  });

  it("reports repeated failures and recovers after a passing report", () => {
    expect(runCommand("initialize").status).toBe(0);
    expect(runCommand("failure").status).toBe(0);
    expect(runCommand("probe").status).toBe(0);
    expect(runCommand("failure").status).toBe(0);

    const failedProbe = runCommand("probe");
    expect(failedProbe.status).toBe(1);
    expect(failedProbe.stderr).toContain("2 consecutive failed checks");

    expect(runCommand("success").status).toBe(0);
    expect(runCommand("probe").status).toBe(0);

    const persistedState = persistedStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
    expect(persistedState.status).toBe("passing");
    expect(persistedState.consecutiveFailures).toBe(0);
    expect(persistedState.lastSuccessfulAt).not.toBeNull();
    expect(persistedState.lastCheckedAt).toBe(persistedState.lastSuccessfulAt);
  });

  it("fails loudly when the monitor interval is invalid", () => {
    const result = runCommand("initialize", {
      CDC_HEALTH_INTERVAL_SECONDS: "invalid",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CDC_HEALTH_INTERVAL_SECONDS must be a positive integer");
  });

  function runCommand(
    action: string,
    environmentOverrides: Record<string, string> = {},
  ): ReturnType<typeof spawnSync> {
    return spawnSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/cdc-health-state.ts"), action],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CDC_HEALTH_INTERVAL_SECONDS: "300",
          CDC_HEALTH_STATE_FILE: statePath,
          ...environmentOverrides,
        },
      },
    );
  }
});
