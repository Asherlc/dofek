import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchAltitudeSyncTrpcClient } from "./watch-altitude-file-sync.ts";

const { mockLoadDeviceErasureCutoff } = vi.hoisted(() => ({
  mockLoadDeviceErasureCutoff: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("./device-erasure-cutoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-erasure-cutoff")>();
  return {
    ...actual,
    loadDeviceErasureCutoff: mockLoadDeviceErasureCutoff,
  };
});

const mockGetPendingWatchAltitudeFileNames = vi.fn((): string[] => []);
const mockReadWatchAltitudeFile = vi.fn(
  (_fileName: string): Promise<Record<string, unknown>[]> => Promise.resolve([]),
);
const mockDeleteWatchFile = vi.fn();

vi.mock("../modules/watch-motion", () => ({
  getPendingWatchAltitudeFileNames: () => mockGetPendingWatchAltitudeFileNames(),
  readWatchAltitudeFile: (fileName: string) => mockReadWatchAltitudeFile(fileName),
  deleteWatchFile: (fileName: string) => mockDeleteWatchFile(fileName),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { syncWatchAltitudeFiles } from "./watch-altitude-file-sync.ts";

function makeTrpcClient(): WatchAltitudeSyncTrpcClient {
  return {
    watchAltitudeSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("syncWatchAltitudeFiles", () => {
  let trpcClient: WatchAltitudeSyncTrpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
    trpcClient = makeTrpcClient();
  });

  it("returns zero when no pending files", async () => {
    mockGetPendingWatchAltitudeFileNames.mockReturnValue([]);

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 });
  });

  it("uploads parsed altitude samples and deletes the file on success", async () => {
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-001.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue([
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        altitudeM: 12.5,
        pressureKPa: 98.2,
      },
    ]);
    vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate).mockResolvedValue({ inserted: 1 });

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 1, filesProcessed: 1, filesFailed: 0 });
    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "Apple Watch",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          altitudeM: 12.5,
          pressureKPa: 98.2,
        },
      ],
    });
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("watch-altitude-001.json.gz");
  });

  it("skips invalid samples and deletes empty files", async () => {
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-empty.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue([{ timestamp: "bad", altitudeM: "nope" }]);

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 0, filesProcessed: 1, filesFailed: 0 });
    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).not.toHaveBeenCalled();
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("watch-altitude-empty.json.gz");
  });

  it("uploads only altitude samples strictly after the durable cutoff", async () => {
    const cutoff = "2026-03-30T12:00:00.000Z";
    mockLoadDeviceErasureCutoff.mockResolvedValue(cutoff);
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-old-account.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue([
      { timestamp: cutoff, altitudeM: 10 },
      { timestamp: "2026-03-30T12:00:01.000Z", altitudeM: 11 },
    ]);

    await syncWatchAltitudeFiles(trpcClient);

    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "Apple Watch",
      samples: [{ timestamp: "2026-03-30T12:00:01.000Z", altitudeM: 11 }],
    });
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("watch-altitude-old-account.json.gz");
  });

  it("does not delete a file when upload fails", async () => {
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-fail.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue([
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        altitudeM: 12.5,
      },
    ]);
    const uploadError = new Error("Server error 500");
    vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate).mockRejectedValue(uploadError);

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 0, filesProcessed: 0, filesFailed: 1 });
    expect(mockDeleteWatchFile).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(uploadError, {
      source: "watch-altitude-file-sync",
      extra: { fileName: "watch-altitude-fail.json.gz" },
    });
  });

  it("increments filesFailed when reading a file fails", async () => {
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-read-fail.json.gz"]);
    const readError = new Error("File not found");
    mockReadWatchAltitudeFile.mockRejectedValue(readError);

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 0, filesProcessed: 0, filesFailed: 1 });
    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).not.toHaveBeenCalled();
    expect(mockDeleteWatchFile).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(readError, {
      source: "watch-altitude-file-sync",
      extra: { fileName: "watch-altitude-read-fail.json.gz" },
    });
  });

  it("uploads large files in batches of 2000 samples", async () => {
    const samples = Array.from({ length: 2001 }, (_, index) => ({
      timestamp: `2026-03-30T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      altitudeM: index,
    }));
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-large.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue(samples);
    vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 2000 })
      .mockResolvedValueOnce({ inserted: 1 });

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 2001, filesProcessed: 1, filesFailed: 0 });
    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate).mock.calls[0]?.[0].samples,
    ).toHaveLength(2000);
    expect(
      vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate).mock.calls[1]?.[0].samples,
    ).toHaveLength(1);
    expect(mockDeleteWatchFile).toHaveBeenCalledWith("watch-altitude-large.json.gz");
  });

  it("does not delete a file when a later batch fails", async () => {
    const samples = Array.from({ length: 2001 }, (_, index) => ({
      timestamp: `2026-03-30T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      altitudeM: index,
    }));
    mockGetPendingWatchAltitudeFileNames.mockReturnValue(["watch-altitude-partial.json.gz"]);
    mockReadWatchAltitudeFile.mockResolvedValue(samples);
    const batchError = new Error("Batch 2 failed");
    vi.mocked(trpcClient.watchAltitudeSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 2000 })
      .mockRejectedValueOnce(batchError);

    const result = await syncWatchAltitudeFiles(trpcClient);

    expect(result).toEqual({ totalInserted: 2000, filesProcessed: 0, filesFailed: 1 });
    expect(trpcClient.watchAltitudeSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(mockDeleteWatchFile).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(batchError, {
      source: "watch-altitude-file-sync",
      extra: { fileName: "watch-altitude-partial.json.gz" },
    });
  });
});
