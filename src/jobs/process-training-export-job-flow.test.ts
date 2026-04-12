import type { ChildProcess } from "node:child_process";
import { EventEmitter, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.spawn before importing the module under test
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

import { spawn } from "node:child_process";
import * as Sentry from "@sentry/node";
import { logger } from "../logger.ts";
import { processTrainingExportJob } from "./process-training-export-job.ts";

const mockSpawn = vi.mocked(spawn);
const mockLoggerInfo = vi.mocked(logger.info);
const mockLoggerWarn = vi.mocked(logger.warn);
const mockLoggerError = vi.mocked(logger.error);
const mockCaptureException = vi.mocked(Sentry.captureException);

function createMockJob(data: { since?: string; until?: string } = {}) {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    extendLock: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock child process that satisfies ChildProcess for spawn. */
function createMockChildProcess(): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    stdio: [null, stdout, stderr, null, null] satisfies [
      null,
      Readable,
      Readable,
      null,
      null,
    ],
    pid: 12345,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "python",
    killed: false,
    kill: vi.fn().mockReturnValue(true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  }) satisfies ChildProcess;
}

/** Set up mockSpawn to return a fresh mock child process. */
function spawnReturningChild(): ChildProcess {
  const child = createMockChildProcess();
  mockSpawn.mockReturnValue(child);
  return child;
}

describe("processTrainingExportJob", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.DATABASE_URL = "postgres://test:test@localhost/test";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("spawns Python with correct arguments", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 0);

    await exportPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "python",
      expect.arrayContaining([
        "-m",
        "dofek_ml.export",
        "--database-url",
        "postgres://test:test@localhost/test",
      ]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("passes since and until as CLI args", async () => {
    const job = createMockJob({ since: "2026-03-01T00:00:00Z", until: "2026-03-31T00:00:00Z" });
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 0);

    await exportPromise;

    const spawnArgs = mockSpawn.mock.calls[0]?.[1];
    expect(spawnArgs).toContain("--since");
    expect(spawnArgs).toContain("2026-03-01T00:00:00Z");
    expect(spawnArgs).toContain("--until");
    expect(spawnArgs).toContain("2026-03-31T00:00:00Z");
  });

  it("forwards progress JSON lines to job.updateProgress", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push('{"percentage": 50, "message": "Exporting..."}\n');
    child.stdout?.push('{"percentage": 100, "message": "Done"}\n');
    child.stdout?.push(null);
    child.stderr?.push(null);

    await vi.advanceTimersByTimeAsync(0);

    child.emit("close", 0);
    await exportPromise;

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 50,
      message: "Exporting...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "Done",
    });
  });

  it("rejects when Python process exits with non-zero code", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stderr?.push("Traceback: some error\n");
    child.stdout?.push(null);
    child.stderr?.push(null);

    await vi.advanceTimersByTimeAsync(0);

    child.emit("close", 1);

    await expect(exportPromise).rejects.toThrow("Traceback: some error");
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("rejects when spawn fails", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.emit("error", new Error("ENOENT: python not found"));

    await expect(exportPromise).rejects.toThrow("Failed to spawn Python export process");
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("throws when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    const job = createMockJob();

    await expect(processTrainingExportJob(job)).rejects.toThrow(
      "DATABASE_URL environment variable is required",
    );
  });

  it("logs start and completion", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 0);

    await exportPromise;

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[training-export] Starting training data export (since=all, until=now)",
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[training-export] Export complete in"),
    );
  });

  it("logs error on failure", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 1);

    await expect(exportPromise).rejects.toThrow();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("[training-export] Job failed after"),
    );
  });

  it("warns but does not throw when updateProgress fails", async () => {
    const job = createMockJob();
    job.updateProgress.mockRejectedValue(new Error("Redis down"));
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push('{"percentage": 50, "message": "Exporting..."}\n');
    child.stdout?.push(null);
    child.stderr?.push(null);

    await vi.advanceTimersByTimeAsync(0);

    child.emit("close", 0);
    await exportPromise;

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update progress"),
    );
  });

  it("extends lock periodically during export", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    // Advance time past the lock extend interval (60s)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.extendLock).toHaveBeenCalledWith(600_000);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 0);

    await exportPromise;
  });

  it("clears lock interval after completion", async () => {
    const job = createMockJob();
    const child = spawnReturningChild();

    const exportPromise = processTrainingExportJob(job);

    child.stdout?.push(null);
    child.stderr?.push(null);
    child.emit("close", 0);

    await exportPromise;

    const callsBefore = job.extendLock.mock.calls.length;

    // Advance time well past the interval — lock should NOT be extended
    await vi.advanceTimersByTimeAsync(300_000);

    expect(job.extendLock.mock.calls.length).toBe(callsBefore);
  });
});
