import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueueWaitUntilReady = vi.fn(async () => undefined);
const mockQueueGetJobCounts = vi.fn(async () => ({ waiting: 0 }));
const mockQueueClose = vi.fn(async () => undefined);
const mockQueue = {
  waitUntilReady: mockQueueWaitUntilReady,
  getJobCounts: mockQueueGetJobCounts,
  close: mockQueueClose,
};

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
    vi.useRealTimers();
    mockQueueWaitUntilReady.mockResolvedValue(undefined);
    mockQueueGetJobCounts.mockResolvedValue({ waiting: 0 });
    mockQueueClose.mockResolvedValue(undefined);
  });

  it("checks every worker queue and closes queue clients", async () => {
    await expect(checkWorkerQueues()).resolves.toEqual({ status: "ok", queues: "ok" });

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

  it("clears the timeout after a successful queue check", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      await expect(checkWorkerQueues({ timeoutMs: 1_000 })).resolves.toEqual({
        status: "ok",
        queues: "ok",
      });
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
