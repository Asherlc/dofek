import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const mockQueueWaitUntilReady = vi.fn(async () => undefined);
const mockQueueGetJobCounts = vi.fn(async () => ({ waiting: 0 }));
const mockQueueClose = vi.fn(async () => undefined);
const mockSentryInit = vi.fn();
const mockSentryCaptureException = vi.fn();
const mockExecFile = vi.fn(
  (
    _file: string,
    _arguments: readonly string[],
    _options: { encoding: string },
    callback: ExecFileCallback,
  ) => {
    callback(null, "node --experimental-strip-types src/jobs/worker.ts\n", "");
    return null;
  },
);
const mockQueue = {
  waitUntilReady: mockQueueWaitUntilReady,
  getJobCounts: mockQueueGetJobCounts,
  close: mockQueueClose,
};

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("@sentry/node", () => ({
  captureException: mockSentryCaptureException,
  init: mockSentryInit,
}));

vi.mock("./queues.ts", () => ({
  createActivityDeleteAnalyticsQueue: vi.fn(() => mockQueue),
  createExportQueue: vi.fn(() => mockQueue),
  createImportQueue: vi.fn(() => mockQueue),
  createPostSyncQueue: vi.fn(() => mockQueue),
  createScheduledSyncQueue: vi.fn(() => mockQueue),
  createSyncQueue: vi.fn(() => mockQueue),
}));

const { checkWorkerQueues } = await import("./worker-health.ts");

describe("checkWorkerQueues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueWaitUntilReady.mockResolvedValue(undefined);
    mockQueueGetJobCounts.mockResolvedValue({ waiting: 0 });
    mockQueueClose.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (
        _file: string,
        _arguments: readonly string[],
        _options: { encoding: string },
        callback: ExecFileCallback,
      ) => {
        callback(null, "node --experimental-strip-types src/jobs/worker.ts\n", "");
        return null;
      },
    );
  });

  it("checks every worker queue and closes queue clients", async () => {
    await expect(checkWorkerQueues()).resolves.toEqual({
      status: "ok",
      queues: "ok",
    });

    expect(mockQueueWaitUntilReady).toHaveBeenCalledTimes(6);
    expect(mockQueueGetJobCounts).toHaveBeenCalledTimes(6);
    expect(mockQueueClose).toHaveBeenCalledTimes(6);
  });

  it("fails when a worker queue cannot reach Redis", async () => {
    mockQueueGetJobCounts.mockRejectedValueOnce(new Error("redis offline"));

    await expect(checkWorkerQueues()).rejects.toThrow("redis offline");
    expect(mockQueueClose).toHaveBeenCalledTimes(6);
  });

  it("fails when a later worker queue cannot reach Redis", async () => {
    mockQueueGetJobCounts
      .mockResolvedValueOnce({ waiting: 0 })
      .mockRejectedValueOnce(new Error("later redis offline"));

    await expect(checkWorkerQueues()).rejects.toThrow("later redis offline");
    expect(mockQueueClose).toHaveBeenCalledTimes(6);
  });

  it("fails when queue cleanup fails", async () => {
    mockQueueClose.mockRejectedValueOnce(new Error("close failed"));

    await expect(checkWorkerQueues()).rejects.toThrow("close failed");
  });

  it("fails and closes queue clients when queue readiness times out", async () => {
    mockQueueWaitUntilReady.mockImplementationOnce(() => new Promise(() => undefined));

    await expect(checkWorkerQueues({ timeoutMs: 1 })).rejects.toThrow(
      "worker queue readiness timed out",
    );
    expect(mockQueueClose).toHaveBeenCalledTimes(6);
  });

  it("fails when required worker process is not running", async () => {
    await expect(
      checkWorkerQueues({
        requireWorkerProcess: true,
        processArgumentsProvider: async () => ["node src/jobs/worker-health.ts"],
      }),
    ).rejects.toThrow("worker process is not running");
    expect(mockQueueWaitUntilReady).not.toHaveBeenCalled();
  });

  it("initializes Sentry and prints queue health when run directly", async () => {
    const originalArgv = [...process.argv];
    const originalSentryDsn = process.env.SENTRY_DSN;
    const originalSentryDsnUnencrypted = process.env.SENTRY_DSN_unencrypted;
    const originalWorkerHealthProcessArgs = process.env.WORKER_HEALTH_PROCESS_ARGS;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv[1] = "worker-health.ts";
      process.env.SENTRY_DSN = "https://example@sentry.test/1";
      process.env.WORKER_HEALTH_PROCESS_ARGS = "node --experimental-strip-types src/jobs/worker.ts";
      delete process.env.SENTRY_DSN_unencrypted;

      await import("./worker-health.ts");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockSentryInit).toHaveBeenCalledWith({
        dsn: "https://example@sentry.test/1",
        skipOpenTelemetrySetup: true,
      });
      expect(stdoutWrite).toHaveBeenCalledWith(
        `${JSON.stringify({ status: "ok", queues: "ok" })}\n`,
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalSentryDsn === undefined) {
        delete process.env.SENTRY_DSN;
      } else {
        process.env.SENTRY_DSN = originalSentryDsn;
      }
      if (originalSentryDsnUnencrypted === undefined) {
        delete process.env.SENTRY_DSN_unencrypted;
      } else {
        process.env.SENTRY_DSN_unencrypted = originalSentryDsnUnencrypted;
      }
      if (originalWorkerHealthProcessArgs === undefined) {
        delete process.env.WORKER_HEALTH_PROCESS_ARGS;
      } else {
        process.env.WORKER_HEALTH_PROCESS_ARGS = originalWorkerHealthProcessArgs;
      }
      stdoutWrite.mockRestore();
    }
  });

  it("does not start the health check when imported as a module", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv[1] = "different-entrypoint.ts";

      await import("./worker-health.ts");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockSentryInit).not.toHaveBeenCalled();
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      stdoutWrite.mockRestore();
    }
  });

  it("does not inspect the entrypoint path when argv has no script", async () => {
    const originalArgv = [...process.argv];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv.splice(1, process.argv.length - 1);

      await expect(import("./worker-health.ts")).resolves.toBeDefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      stdoutWrite.mockRestore();
    }
  });

  it("skips Sentry initialization when run directly without a DSN", async () => {
    const originalArgv = [...process.argv];
    const originalSentryDsn = process.env.SENTRY_DSN;
    const originalSentryDsnUnencrypted = process.env.SENTRY_DSN_unencrypted;
    const originalWorkerHealthProcessArgs = process.env.WORKER_HEALTH_PROCESS_ARGS;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv[1] = "/tmp/worker-health.ts";
      delete process.env.SENTRY_DSN;
      delete process.env.SENTRY_DSN_unencrypted;
      process.env.WORKER_HEALTH_PROCESS_ARGS = "node --experimental-strip-types src/jobs/worker.ts";

      await import("./worker-health.ts");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockSentryInit).not.toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenCalledWith(
        `${JSON.stringify({ status: "ok", queues: "ok" })}\n`,
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalSentryDsn === undefined) {
        delete process.env.SENTRY_DSN;
      } else {
        process.env.SENTRY_DSN = originalSentryDsn;
      }
      if (originalSentryDsnUnencrypted === undefined) {
        delete process.env.SENTRY_DSN_unencrypted;
      } else {
        process.env.SENTRY_DSN_unencrypted = originalSentryDsnUnencrypted;
      }
      if (originalWorkerHealthProcessArgs === undefined) {
        delete process.env.WORKER_HEALTH_PROCESS_ARGS;
      } else {
        process.env.WORKER_HEALTH_PROCESS_ARGS = originalWorkerHealthProcessArgs;
      }
      stdoutWrite.mockRestore();
    }
  });
});
