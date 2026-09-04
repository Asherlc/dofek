import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseImuEnvelope } from "./imu-upload.ts";
import { createWatchImuChunkSync } from "./watch-imu-chunk-sync.ts";

const fsMocks = vi.hoisted(() => ({
  mkdirSync: vi.fn<(options: { path: string }) => number>(),
  readFileSync:
    vi.fn<
      (options: {
        path: string;
        options?: { encoding?: string };
      }) => ArrayBuffer | string | undefined
    >(),
  readdirSync: vi.fn<(options: { path: string }) => string[] | undefined>(),
  renameSync: vi.fn<(options: { oldPath: string; newPath: string }) => number>(),
  rmSync: vi.fn<(options: { path: string }) => number>(),
  writeFileSync: vi.fn<(options: { path: string; data: ArrayBuffer | string }) => void>(),
}));

vi.mock("@zos/fs", () => fsMocks);

const input = {
  connectionType: "zepp" as const,
  installId: "install-1",
  segmentId: "segment-1",
  sessionStartMs: 1_720_000_000_000,
  hasGyroscope: true,
  samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
};

const files = new Map<string, string>();
const directories = new Set<string>();

function installMemoryFileSystem(): void {
  files.clear();
  directories.clear();
  fsMocks.mkdirSync.mockImplementation(({ path }) => {
    directories.add(path);
    return 0;
  });
  fsMocks.readdirSync.mockImplementation(({ path }) => {
    if (!directories.has(path)) return undefined;
    const prefix = `${path}/`;
    return [...files.keys()]
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => candidate.slice(prefix.length));
  });
  fsMocks.writeFileSync.mockImplementation(({ path, data }) => {
    files.set(path, String(data));
  });
  fsMocks.renameSync.mockImplementation(({ oldPath, newPath }) => {
    const value = files.get(oldPath);
    if (value === undefined) return -1;
    files.set(newPath, value);
    files.delete(oldPath);
    return 0;
  });
  fsMocks.rmSync.mockImplementation(({ path }) => (files.delete(path) ? 0 : -1));
  fsMocks.readFileSync.mockImplementation(({ path }) => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  });
}

function persistedChunkPaths(): string[] {
  return [...files.keys()].filter((path) => path.endsWith(".json"));
}

describe("watch IMU chunk sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMemoryFileSystem();
  });

  it("persists an independent chunk record before delivery and removes it only after acknowledgement", async () => {
    let acknowledge: ((value: unknown) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const sync = createWatchImuChunkSync("data://imu/chunks", request);

    const delivery = sync.enqueue(input);
    expect(persistedChunkPaths()).toHaveLength(1);
    expect(fsMocks.renameSync).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "segment-1:0:0", version: 1 }),
    );

    acknowledge?.({
      status: "ok",
      acceptedEventIds: ["segment-1:0:0"],
      rejected: [],
    });
    await delivery;
    expect(persistedChunkPaths()).toEqual([]);
  });

  it("stores prolonged offline capture as independent records and ignores an interrupted temp write", async () => {
    const failedRequest = vi.fn(async () => {
      throw new Error("phone unavailable");
    });
    const sync = createWatchImuChunkSync("data://imu/chunks", failedRequest);
    const [sample] = input.samples;
    if (!sample) throw new Error("Test IMU sample is missing.");

    for (const tMs of [0, 100, 200]) {
      await expect(sync.enqueue({ ...input, samples: [{ ...sample, tMs }] })).rejects.toThrow(
        "phone unavailable",
      );
    }
    expect(persistedChunkPaths()).toHaveLength(3);
    expect(
      [...files.values()]
        .filter((value) => value.includes('"batchId"'))
        .every((value) => !value.includes('"pending"')),
    ).toBe(true);

    files.set("data://imu/chunks/interrupted.tmp", "incomplete JSON");
    const replayRequest = vi.fn(async (envelope: unknown) => {
      const parsed = parseImuEnvelope(envelope);
      return {
        status: "ok",
        acceptedEventIds: parsed.events.map((event) => event.eventId),
        rejected: [],
      };
    });
    await createWatchImuChunkSync("data://imu/chunks", replayRequest).retry();

    expect(replayRequest).toHaveBeenCalledTimes(3);
    expect(persistedChunkPaths()).toEqual([]);
    expect(files.get("data://imu/chunks/interrupted.tmp")).toBe("incomplete JSON");
  });

  it("retains a chunk when the phone omits its acknowledgement", async () => {
    const sync = createWatchImuChunkSync("data://imu/chunks", async () => ({
      status: "ok",
      acceptedEventIds: [],
      rejected: [],
    }));

    await expect(sync.enqueue(input)).rejects.toThrow("Phone did not persist the IMU chunk.");
    expect(persistedChunkPaths()).toHaveLength(1);
  });

  it("quarantines a permanently rejected chunk so later records can drain", async () => {
    const failedRequest = vi.fn(async () => {
      throw new Error("phone unavailable");
    });
    const initialSync = createWatchImuChunkSync("data://imu/chunks", failedRequest);
    const [sample] = input.samples;
    if (!sample) throw new Error("Test IMU sample is missing.");
    await expect(initialSync.enqueue(input)).rejects.toThrow("phone unavailable");
    await expect(
      initialSync.enqueue({ ...input, samples: [{ ...sample, tMs: 100 }] }),
    ).rejects.toThrow("phone unavailable");

    const replayRequest = vi.fn(async (envelope: unknown) => {
      const parsed = parseImuEnvelope(envelope);
      const eventId = parsed.events[0]?.eventId ?? "";
      return eventId === "segment-1:0:0"
        ? {
            status: "ok",
            acceptedEventIds: [],
            rejected: [{ eventId, issues: [{ path: "samples.0", message: "Invalid sample" }] }],
          }
        : { status: "ok", acceptedEventIds: [eventId], rejected: [] };
    });

    await createWatchImuChunkSync("data://imu/chunks", replayRequest).retry();

    expect(replayRequest).toHaveBeenCalledTimes(2);
    expect(persistedChunkPaths()).toEqual([]);
    expect(files.has("data://imu/chunks/segment-1%3A0%3A0.rejected")).toBe(true);
  });
});
