import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  processFitFileImportJob: vi.fn(),
  retainFile: vi.fn(),
  waitUntilFinished: vi.fn(),
}));

const queueEvents = { kind: "fit-file-import-events" };
vi.mock("./queues.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queues.ts")>()),
  getFitFileImportQueue: () => ({ add: mocks.add }),
  getFitFileImportQueueEvents: () => queueEvents,
}));
vi.mock("./process-fit-file-import-job.ts", () => ({
  processFitFileImportJob: mocks.processFitFileImportJob,
}));
vi.mock("../provider-artifact-storage.ts", () => ({
  createProviderArtifactStorageFromEnv: () => ({ retainFile: mocks.retainFile }),
}));

import { enqueueFitFileImportAndWait } from "./enqueue-fit-file-import.ts";

const bytes = Buffer.from("received FIT bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const retainedArtifactKey = `provider-artifacts/user-1/wahoo/${digest}.fit`;
const activitySummary = {
  externalId: "workout-42",
  activityType: resolveProviderActivityType("cycling", "cycling"),
  startedAtIso: "2026-07-01T12:00:00.000Z",
  name: "Morning ride",
};
const options = {
  fitBuffer: bytes,
  providerId: "wahoo",
  sourceName: "Wahoo",
  userId: "user-1",
  activitySummary,
};
const db = makeTransactionalTestDatabase({
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
});
const publisher = { publishRows: vi.fn(async () => []) };
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await realpath(await mkdtemp(join(tmpdir(), "fit-staging-test-")));
  vi.stubEnv("JOB_FILES_DIR", directory);
  mocks.retainFile.mockResolvedValue(retainedArtifactKey);
  mocks.processFitFileImportJob.mockResolvedValue({ recordsSynced: 3, errors: [] });
  mocks.waitUntilFinished.mockResolvedValue({ recordsSynced: 0, errors: [] });
  mocks.add.mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function sourceDirectory(filename = "wahoo_workout-42.fit"): string {
  return join(directory, "provider-fit", "user-1", "wahoo", digest, filename);
}

describe("enqueueFitFileImportAndWait", () => {
  it("retains the original before importing inline with the same processing publisher", async () => {
    const order: string[] = [];
    mocks.retainFile.mockImplementation(async ({ filePath }) => {
      expect(await readFile(filePath)).toEqual(bytes);
      order.push("archive");
      return retainedArtifactKey;
    });
    mocks.processFitFileImportJob.mockImplementation(async (job, database, metricPublisher) => {
      order.push("import");
      expect(job.data).toMatchObject({
        originalPath: "wahoo_workout-42.fit",
        retainedArtifactKey,
        userId: "user-1",
        providerId: "wahoo",
        activitySummary,
      });
      expect(database).toBe(db);
      expect(metricPublisher).toBe(publisher);
      expect(await readFile(job.data.filePath)).toEqual(bytes);
      return { recordsSynced: 3, errors: [] };
    });

    await expect(
      enqueueFitFileImportAndWait({ ...options, db, metricStreamPublisher: publisher }),
    ).resolves.toEqual({ recordsSynced: 3, errors: [] });

    expect(order).toEqual(["archive", "import"]);
    expect(mocks.add).not.toHaveBeenCalled();
    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves exact owned bytes and recovery data when storage fails before queueing", async () => {
    const failure = new Error("Original FIT storage is unavailable");
    mocks.retainFile.mockRejectedValue(failure);

    await expect(enqueueFitFileImportAndWait(options)).rejects.toBe(failure);

    const filePath = join(sourceDirectory(), "input.fit");
    expect(await readFile(filePath)).toEqual(bytes);
    expect(JSON.parse(await readFile(join(sourceDirectory(), "import.json"), "utf8"))).toEqual({
      filePath,
      originalPath: "wahoo_workout-42.fit",
      userId: "user-1",
      providerId: "wahoo",
      sourceName: "Wahoo",
      activitySummary,
      deleteFileAfterImport: true,
    });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.processFitFileImportJob).not.toHaveBeenCalled();
  });

  it("reuses pending bytes on resync and cleans them after successful retention", async () => {
    mocks.retainFile.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(enqueueFitFileImportAndWait(options)).rejects.toThrow("Storage unavailable");
    const filePath = join(sourceDirectory(), "input.fit");
    expect(await readFile(filePath)).toEqual(bytes);

    await expect(enqueueFitFileImportAndWait(options)).resolves.toEqual({
      recordsSynced: 0,
      errors: [],
    });

    expect(mocks.retainFile.mock.calls.map(([input]) => input.filePath)).toEqual([
      filePath,
      filePath,
    ]);
    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("queues only after retaining the original and carries the retained key", async () => {
    await enqueueFitFileImportAndWait(options);

    expect(mocks.add).toHaveBeenCalledWith(
      "fit-file-import",
      expect.objectContaining({
        filePath: join(sourceDirectory(), "input.fit"),
        retainedArtifactKey,
        originalPath: "wahoo_workout-42.fit",
        userId: "user-1",
        providerId: "wahoo",
        deleteFileAfterImport: true,
      }),
      expect.any(Object),
    );
    expect(mocks.waitUntilFinished).toHaveBeenCalledWith(queueEvents);
    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans retained local bytes when inline parsing fails", async () => {
    const failure = new Error("Decode failed");
    mocks.processFitFileImportJob.mockRejectedValue(failure);

    await expect(
      enqueueFitFileImportAndWait({ ...options, db, metricStreamPublisher: publisher }),
    ).rejects.toBe(failure);

    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans retained local bytes when queued parsing fails", async () => {
    const failure = new Error("Decode failed");
    mocks.waitUntilFinished.mockRejectedValue(failure);

    await expect(enqueueFitFileImportAndWait(options)).rejects.toBe(failure);

    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps equal bytes for different activity identities independently recoverable", async () => {
    mocks.retainFile.mockRejectedValue(new Error("Storage unavailable"));
    const otherOptions = {
      ...options,
      activitySummary: { ...activitySummary, externalId: "workout-43" },
    };
    await expect(enqueueFitFileImportAndWait(options)).rejects.toThrow("Storage unavailable");
    await expect(enqueueFitFileImportAndWait(otherOptions)).rejects.toThrow("Storage unavailable");

    const firstManifest = join(sourceDirectory(), "import.json");
    const otherDirectory = sourceDirectory("wahoo_workout-43.fit");
    const otherManifest = join(otherDirectory, "import.json");
    expect(JSON.parse(await readFile(firstManifest, "utf8")).activitySummary.externalId).toBe(
      "workout-42",
    );
    expect(JSON.parse(await readFile(otherManifest, "utf8")).activitySummary.externalId).toBe(
      "workout-43",
    );

    mocks.retainFile.mockResolvedValue(retainedArtifactKey);
    await enqueueFitFileImportAndWait(options);

    await expect(access(sourceDirectory())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(otherDirectory, "input.fit"))).toEqual(bytes);
    expect(JSON.parse(await readFile(otherManifest, "utf8")).activitySummary.externalId).toBe(
      "workout-43",
    );
  });
});
