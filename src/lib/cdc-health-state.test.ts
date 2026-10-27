import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CdcHealthStateFile } from "./cdc-health-state.ts";

const persistedStateSchema = z.object({
  consecutiveFailures: z.number().int().nonnegative(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  status: z.enum(["starting", "passing", "failing"]),
});

describe("CdcHealthStateFile", () => {
  let stateDirectory: string;
  let statePath: string;
  let now: Date;
  let stateFile: CdcHealthStateFile;

  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), "dofek-cdc-health-state-"));
    statePath = join(stateDirectory, "state.json");
    now = new Date("2026-07-25T00:00:00.000Z");
    stateFile = new CdcHealthStateFile({
      filePath: statePath,
      intervalSeconds: 300,
      now: () => now,
    });
  });

  afterEach(() => {
    rmSync(stateDirectory, { force: true, recursive: true });
  });

  it("allows a bounded startup window and rejects a stale monitor", () => {
    stateFile.initialize();

    expect(() => stateFile.assertHealthy()).not.toThrow();

    now = new Date("2026-07-25T00:06:00.000Z");
    expect(() => stateFile.assertHealthy()).not.toThrow();

    now = new Date("2026-07-25T00:06:01.000Z");

    expect(() => stateFile.assertHealthy()).toThrow(
      "CDC health monitor has not completed a check within 360 seconds",
    );
  });

  it("becomes unhealthy after two consecutive failed reports", () => {
    stateFile.initialize();
    stateFile.recordFailure();

    expect(() => stateFile.assertHealthy()).not.toThrow();

    now = new Date("2026-07-25T00:05:00.000Z");
    stateFile.recordFailure();

    expect(() => stateFile.assertHealthy()).toThrow(
      "CDC health monitor has 2 consecutive failed checks",
    );
  });

  it("recovers after a passing report and updates the last-success timestamp", () => {
    stateFile.initialize();
    stateFile.recordFailure();
    now = new Date("2026-07-25T00:05:00.000Z");
    stateFile.recordFailure();

    expect(() => stateFile.assertHealthy()).toThrow();

    now = new Date("2026-07-25T00:05:30.000Z");
    stateFile.recordSuccess();

    expect(() => stateFile.assertHealthy()).not.toThrow();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(persistedStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")))).toEqual({
      consecutiveFailures: 0,
      lastCheckedAt: "2026-07-25T00:05:30.000Z",
      lastSuccessfulAt: "2026-07-25T00:05:30.000Z",
      startedAt: "2026-07-25T00:00:00.000Z",
      status: "passing",
    });
  });

  it("retains the last-success timestamp while a later check is failing", () => {
    stateFile.initialize();
    now = new Date("2026-07-25T00:01:00.000Z");
    stateFile.recordSuccess();
    now = new Date("2026-07-25T00:02:00.000Z");
    stateFile.recordFailure();

    expect(persistedStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")))).toMatchObject({
      consecutiveFailures: 1,
      lastCheckedAt: "2026-07-25T00:02:00.000Z",
      lastSuccessfulAt: "2026-07-25T00:01:00.000Z",
      status: "failing",
    });
  });

  it("rejects a stale failed report even before the second check", () => {
    stateFile.initialize();
    stateFile.recordFailure();
    now = new Date("2026-07-25T00:06:00.000Z");

    expect(() => stateFile.assertHealthy()).not.toThrow();

    now = new Date("2026-07-25T00:06:01.000Z");

    expect(() => stateFile.assertHealthy()).toThrow(
      "CDC health monitor state is older than 360 seconds",
    );
  });

  it.each([0, -1, 1.5])("rejects invalid interval %s", (intervalSeconds) => {
    expect(
      () =>
        new CdcHealthStateFile({
          filePath: statePath,
          intervalSeconds,
        }),
    ).toThrow("CDC health interval must be a positive integer");
  });

  it("uses the system clock when no clock dependency is provided", () => {
    const beforeInitialize = Date.now();
    const systemClockState = new CdcHealthStateFile({
      filePath: statePath,
      intervalSeconds: 300,
    });
    systemClockState.initialize();
    const afterInitialize = Date.now();
    const persistedState = persistedStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
    const startedAt = new Date(persistedState.startedAt).getTime();

    expect(startedAt).toBeGreaterThanOrEqual(beforeInitialize);
    expect(startedAt).toBeLessThanOrEqual(afterInitialize);
  });

  it("removes the temporary file when the atomic rename fails", () => {
    const directoryTarget = join(stateDirectory, "directory-target");
    mkdirSync(directoryTarget);
    const directoryStateFile = new CdcHealthStateFile({
      filePath: directoryTarget,
      intervalSeconds: 300,
    });

    expect(() => directoryStateFile.initialize()).toThrow();
    expect(readdirSync(stateDirectory)).toEqual(["directory-target"]);
  });

  it("rejects malformed persisted state", () => {
    writeFileSync(statePath, '{"status":"passing"}', "utf8");

    expect(() => stateFile.assertHealthy()).toThrow();
  });
});
