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
});
