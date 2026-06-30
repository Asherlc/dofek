import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueueWaitUntilReady = vi.fn(async () => undefined);
const mockQueueGetJobCounts = vi.fn(async () => ({ waiting: 0 }));
const mockQueueClose = vi.fn(async () => undefined);
const mockSentryInit = vi.fn();
const mockSentryCaptureException = vi.fn();
const mockQueue = {
  waitUntilReady: mockQueueWaitUntilReady,
  getJobCounts: mockQueueGetJobCounts,
  close: mockQueueClose,
};

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

  it("initializes Sentry and prints queue health when run directly", async () => {
    const originalArgv = [...process.argv];
    const originalSentryDsn = process.env.SENTRY_DSN;
    const originalSentryDsnUnencrypted = process.env.SENTRY_DSN_unencrypted;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv[1] = "worker-health.ts";
      process.env.SENTRY_DSN = "https://example@sentry.test/1";
      delete process.env.SENTRY_DSN_unencrypted;

      await import("./worker-health.ts");
      await new Promise<void>((resolve) => setImmediate(resolve));

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
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      vi.resetModules();
      process.argv[1] = "/tmp/worker-health.ts";
      delete process.env.SENTRY_DSN;
      delete process.env.SENTRY_DSN_unencrypted;

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
      stdoutWrite.mockRestore();
    }
  });
});
