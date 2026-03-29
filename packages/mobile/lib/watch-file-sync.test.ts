import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InertialMeasurementUnitSample } from "../modules/core-motion";

const mockGetPendingWatchFileNames = vi.fn((): string[] => []);
const mockReadWatchFile = vi.fn(
  (): Promise<InertialMeasurementUnitSample[]> => Promise.resolve([]),
);
const mockDeleteWatchFile = vi.fn();
const mockRequestWatchRecording = vi.fn(() => Promise.resolve(true));

vi.mock("../modules/watch-motion", () => ({
  getPendingWatchFileNames: () => mockGetPendingWatchFileNames(),
  readWatchFile: (fileName: string) => mockReadWatchFile(fileName),
  deleteWatchFile: (fileName: string) => mockDeleteWatchFile(fileName),
  requestWatchRecording: () => mockRequestWatchRecording(),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { InertialMeasurementUnitSyncTrpcClient } from "./inertial-measurement-unit-sync.ts";
import { syncWatchAccelerometerFiles } from "./watch-file-sync.ts";

function makeSamples(count: number): InertialMeasurementUnitSample[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.now() - (count - index) * 20).toISOString(),
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: Math.random() * 2 - 1,
  }));
}

function makeTrpcClient(): InertialMeasurementUnitSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("syncWatchAccelerometerFiles", () => {
  let trpcClient: InertialMeasurementUnitSyncTrpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    trpcClient = makeTrpcClient();
  });

  it("returns zero when no pending files", async () => {
    mockGetPendingWatchFileNames.mockReturnValue([]);

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 });
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
  });

  it("processes a single file and deletes it on success", async () => {
    const samples = makeSamples(100);
    mockGetPendingWatchFileNames.mockReturnValue(["watch-accel-001.json.gz"]);
    mockReadWatchFile.mockResolvedValue(samples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockResolvedValue({
      inserted: 100,
    });

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.totalInserted).toBe(100);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("watch-accel-001.json.gz");
  });

  it("processes multiple files independently", async () => {
    const samples1 = makeSamples(50);
    const samples2 = makeSamples(75);
    mockGetPendingWatchFileNames.mockReturnValue(["file-a.json.gz", "file-b.json.gz"]);
    mockReadWatchFile.mockResolvedValueOnce(samples1).mockResolvedValueOnce(samples2);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 50 })
      .mockResolvedValueOnce({ inserted: 75 });

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.totalInserted).toBe(125);
    expect(result.filesProcessed).toBe(2);
    expect(result.filesFailed).toBe(0);
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("file-a.json.gz");
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("file-b.json.gz");
  });

  it("skips a file that fails to parse and continues with others", async () => {
    const goodSamples = makeSamples(50);
    mockGetPendingWatchFileNames.mockReturnValue(["bad-file.json.gz", "good-file.json.gz"]);
    mockReadWatchFile
      .mockRejectedValueOnce(new Error("PARSE_ERROR: corrupt file"))
      .mockResolvedValueOnce(goodSamples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockResolvedValue({
      inserted: 50,
    });

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.totalInserted).toBe(50);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(1);
    // Bad file should NOT be deleted (data might be recoverable later)
    expect(mockDeleteWatchFile).not.toHaveBeenCalledWith("bad-file.json.gz");
    // Good file should be deleted
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("good-file.json.gz");
  });

  it("skips a file that fails to upload and continues with others", async () => {
    const samples1 = makeSamples(50);
    const samples2 = makeSamples(30);
    mockGetPendingWatchFileNames.mockReturnValue(["fail-upload.json.gz", "ok-upload.json.gz"]);
    mockReadWatchFile.mockResolvedValueOnce(samples1).mockResolvedValueOnce(samples2);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate)
      .mockRejectedValueOnce(new Error("Server error 500"))
      .mockResolvedValueOnce({ inserted: 30 });

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.totalInserted).toBe(30);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(1);
    // Failed upload file should NOT be deleted
    expect(mockDeleteWatchFile).not.toHaveBeenCalledWith("fail-upload.json.gz");
    // Successful file should be deleted
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("ok-upload.json.gz");
  });

  it("deletes empty files without uploading", async () => {
    mockGetPendingWatchFileNames.mockReturnValue(["empty-file.json.gz"]);
    mockReadWatchFile.mockResolvedValue([]);

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.totalInserted).toBe(0);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("empty-file.json.gz");
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
  });

  it("uploads samples in batches of 5000", async () => {
    const samples = makeSamples(7500);
    mockGetPendingWatchFileNames.mockReturnValue(["big-file.json.gz"]);
    mockReadWatchFile.mockResolvedValue(samples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockResolvedValue({
      inserted: 5000,
    });

    await syncWatchAccelerometerFiles(trpcClient);

    const mutate = trpcClient.inertialMeasurementUnitSync.pushSamples.mutate;
    expect(mutate).toHaveBeenCalledTimes(2);
    const firstBatch = vi.mocked(mutate).mock.calls[0][0];
    expect(firstBatch.samples).toHaveLength(5000);
    expect(firstBatch.deviceType).toBe("apple_watch");
    const secondBatch = vi.mocked(mutate).mock.calls[1][0];
    expect(secondBatch.samples).toHaveLength(2500);
  });

  it("reports errors to Sentry for failed files", async () => {
    const parseError = new Error("PARSE_ERROR: corrupt");
    mockGetPendingWatchFileNames.mockReturnValue(["corrupt.json.gz"]);
    mockReadWatchFile.mockRejectedValue(parseError);

    await syncWatchAccelerometerFiles(trpcClient);

    expect(mockCaptureException).toHaveBeenCalledWith(parseError, {
      source: "watch-file-sync",
      extra: { fileName: "corrupt.json.gz" },
    });
  });

  it("does not delete a file when a later batch fails", async () => {
    const samples = makeSamples(7500);
    mockGetPendingWatchFileNames.mockReturnValue(["partial-fail.json.gz"]);
    mockReadWatchFile.mockResolvedValue(samples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 5000 })
      .mockRejectedValueOnce(new Error("Timeout on batch 2"));

    const result = await syncWatchAccelerometerFiles(trpcClient);

    expect(result.filesFailed).toBe(1);
    expect(result.filesProcessed).toBe(0);
    // File should NOT be deleted because not all batches succeeded
    expect(mockDeleteWatchFile).not.toHaveBeenCalled();
  });
});
