import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  processFitFileImportJob: vi.fn(),
  waitUntilFinished: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));

const queueEvents = { kind: "fit-file-import-events" };

vi.mock("./queues.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./queues.ts")>();
  return {
    ...original,
    getFitFileImportQueue: () => ({ add: mocks.add }),
    getFitFileImportQueueEvents: () => queueEvents,
  };
});

vi.mock("./process-fit-file-import-job.ts", () => ({
  processFitFileImportJob: mocks.processFitFileImportJob,
}));

import { enqueueFitFileImportAndWait } from "./enqueue-fit-file-import.ts";

describe("enqueueFitFileImportAndWait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JOB_FILES_DIR", "/app/job-files");
    mocks.mkdtemp.mockResolvedValue("/app/job-files/provider-fit-random");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.processFitFileImportJob.mockResolvedValue({ recordsSynced: 3, errors: [] });
    mocks.waitUntilFinished.mockResolvedValue({ recordsSynced: 0, errors: [] });
    mocks.add.mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
  });

  it("runs the import in-process when a metric stream publisher is supplied", async () => {
    const db: SyncDatabase = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    };
    const activitySummary = {
      externalId: "workout-42",
      activityType: resolveProviderActivityType("cycling", "cycling"),
      startedAtIso: "2026-07-01T12:00:00.000Z",
      endedAtIso: "2026-07-01T13:00:00.000Z",
      name: "Morning ride",
    };

    await expect(
      enqueueFitFileImportAndWait({
        fitBuffer: Buffer.from([1, 2, 3]),
        providerId: "wahoo",
        sourceName: "Wahoo",
        userId: "user-1",
        activitySummary,
        db,
        metricStreamPublisher,
      }),
    ).resolves.toEqual({ recordsSynced: 3, errors: [] });

    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.processFitFileImportJob).toHaveBeenCalledWith(
      {
        data: {
          filePath: "/app/job-files/provider-fit-random/input.fit",
          originalPath: "wahoo_workout-42.fit",
          userId: "user-1",
          providerId: "wahoo",
          sourceName: "Wahoo",
          activitySummary,
        },
        updateProgress: expect.any(Function),
      },
      db,
      metricStreamPublisher,
    );
  });

  it("keeps the staged file until an in-process import finishes", async () => {
    let resolveImport: ((result: { recordsSynced: number; errors: never[] }) => void) | undefined;
    const importPromise = new Promise<{ recordsSynced: number; errors: never[] }>((resolve) => {
      resolveImport = resolve;
    });
    mocks.processFitFileImportJob.mockReturnValue(importPromise);

    const enqueuePromise = enqueueFitFileImportAndWait({
      fitBuffer: Buffer.from([1, 2, 3]),
      providerId: "wahoo",
      sourceName: "Wahoo",
      userId: "user-1",
      activitySummary: {
        externalId: "workout-42",
        activityType: resolveProviderActivityType("cycling", "cycling"),
        startedAtIso: "2026-07-01T12:00:00.000Z",
        endedAtIso: "2026-07-01T13:00:00.000Z",
        name: "Morning ride",
      },
      db: {
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      },
      metricStreamPublisher: {
        publishRows: vi.fn(async () => []),
      },
    });

    await vi.waitFor(() => expect(mocks.processFitFileImportJob).toHaveBeenCalledOnce());
    expect(mocks.rm).not.toHaveBeenCalled();

    if (!resolveImport) {
      throw new Error("expected in-process import to start");
    }
    resolveImport({ recordsSynced: 3, errors: [] });

    await expect(enqueuePromise).resolves.toEqual({ recordsSynced: 3, errors: [] });
    expect(mocks.rm).toHaveBeenCalledWith("/app/job-files/provider-fit-random", {
      recursive: true,
      force: true,
    });
  });

  it("stages a downloaded FIT file and waits for the canonical import job", async () => {
    const activitySummary = {
      externalId: "workout-42",
      activityType: resolveProviderActivityType("cycling", "cycling"),
      startedAtIso: "2026-07-01T12:00:00.000Z",
      endedAtIso: "2026-07-01T13:00:00.000Z",
      name: "Morning ride",
    };

    await expect(
      enqueueFitFileImportAndWait({
        fitBuffer: Buffer.from([1, 2, 3]),
        providerId: "wahoo",
        sourceName: "Wahoo",
        userId: "user-1",
        activitySummary,
      }),
    ).resolves.toEqual({ recordsSynced: 0, errors: [] });

    expect(mocks.mkdir).toHaveBeenCalledWith("/app/job-files", { recursive: true });
    expect(mocks.mkdtemp).toHaveBeenCalledWith("/app/job-files/provider-fit-");
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/app/job-files/provider-fit-random/input.fit",
      Buffer.from([1, 2, 3]),
    );
    expect(mocks.add).toHaveBeenCalledWith(
      "fit-file-import",
      {
        filePath: "/app/job-files/provider-fit-random/input.fit",
        originalPath: "wahoo_workout-42.fit",
        userId: "user-1",
        providerId: "wahoo",
        sourceName: "Wahoo",
        activitySummary,
        deleteFileAfterImport: true,
      },
      {
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );
    expect(mocks.waitUntilFinished).toHaveBeenCalledWith(queueEvents);
    expect(mocks.rm).toHaveBeenCalledWith("/app/job-files/provider-fit-random", {
      recursive: true,
      force: true,
    });
  });

  it("removes the staging directory when the import job fails", async () => {
    mocks.waitUntilFinished.mockRejectedValue(new Error("decode failed"));

    await expect(
      enqueueFitFileImportAndWait({
        fitBuffer: Buffer.from([1, 2, 3]),
        providerId: "coros",
        sourceName: "COROS",
        userId: "user-1",
        activitySummary: {
          externalId: "workout-7",
          activityType: resolveProviderActivityType("running", "running"),
          startedAtIso: "2026-07-01T12:00:00.000Z",
          endedAtIso: "2026-07-01T13:00:00.000Z",
          name: "Run",
        },
      }),
    ).rejects.toThrow("decode failed");

    expect(mocks.rm).toHaveBeenCalledWith("/app/job-files/provider-fit-random", {
      recursive: true,
      force: true,
    });
  });
});
