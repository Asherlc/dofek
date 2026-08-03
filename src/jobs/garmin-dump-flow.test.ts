import type { FlowJob } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGarminFitBatchId, type PreparedGarminDumpImport } from "../providers/garmin-dump.ts";
import { attachGarminFitImportFlow } from "./garmin-dump-flow.ts";
import { getFlowProducer } from "./queues.ts";

const mockAdd = vi.fn().mockResolvedValue({});

vi.mock("./queues.ts", () => ({
  FIT_FILE_IMPORT_BATCH_QUEUE: "fit-file-import-batch",
  FIT_FILE_IMPORT_QUEUE: "fit-file-import",
  ZIP_ENTRY_EXTRACT_QUEUE: "zip-entry-extract",
  getFlowProducer: vi.fn(() => ({ add: mockAdd })),
}));

const preparedImport = {
  uploadPath: "/job-files/upload.zip",
  userId: "user-1",
  batchId: "garmin-dump-fit-batch-abc123",
  baseResult: { recordsSynced: 0, errors: [] },
  fitJobEntries: [
    {
      entry: {
        path: "nested/activity.fit",
        archivePath: "/job-files/upload.zip",
        entryPath: ["nested.zip", "activity.fit"],
        outputDirectory: "/job-files/extracted",
        maxBytes: 128 * 1024 * 1024,
        nestedArchiveMaxBytes: 1024 * 1024 * 1024,
      },
      data: {
        originalPath: "nested/activity.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      },
    },
    {
      entry: {
        path: "direct.fit",
        filePath: "/job-files/extracted/direct.fit",
      },
      data: {
        originalPath: "direct.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      },
    },
  ],
  tempDirectories: ["/job-files/extracted"],
  totalFitFiles: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockResolvedValue({});
});

describe("attachGarminFitImportFlow", () => {
  it("attaches one deterministic batch subtree to the import parent", async () => {
    await attachGarminFitImportFlow(preparedImport, {
      id: "import-job-1",
      queue: "bull:import",
    });

    expect(getFlowProducer).toHaveBeenCalledOnce();
    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockAdd).toHaveBeenCalledWith({
      name: "fit-file-import-batch",
      queueName: "fit-file-import-batch",
      data: { type: "fit-file-import-batch", userId: "user-1" },
      opts: {
        jobId: "garmin-dump-fit-batch-abc123",
        parent: { id: "import-job-1", queue: "bull:import" },
        ignoreDependencyOnFailure: true,
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
      children: [
        expect.objectContaining({
          name: "fit-file-import",
          queueName: "fit-file-import",
          data: {
            originalPath: "nested/activity.fit",
            userId: "user-1",
            providerId: "garmin-dump",
            sourceName: "Garmin Dump",
          },
          opts: expect.objectContaining({
            jobId: expect.stringMatching(/^garmin-dump-fit-[a-f0-9]{64}$/),
            ignoreDependencyOnFailure: true,
            removeOnComplete: { age: 86_400 },
            removeOnFail: { age: 604_800 },
          }),
          children: [
            expect.objectContaining({
              name: "zip-entry-extract",
              queueName: "zip-entry-extract",
              data: {
                archivePath: "/job-files/upload.zip",
                entryPath: ["nested.zip", "activity.fit"],
                outputDirectory: "/job-files/extracted",
                outputExtension: "fit",
                maxBytes: 128 * 1024 * 1024,
                nestedArchiveMaxBytes: 1024 * 1024 * 1024,
                userId: "user-1",
              },
              opts: expect.objectContaining({
                jobId: expect.stringMatching(/^garmin-dump-fit-extract-[a-f0-9]{64}$/),
                ignoreDependencyOnFailure: true,
                removeOnComplete: { age: 86_400 },
                removeOnFail: { age: 604_800 },
              }),
            }),
          ],
        }),
        expect.objectContaining({
          name: "fit-file-import",
          data: {
            originalPath: "direct.fit",
            userId: "user-1",
            providerId: "garmin-dump",
            sourceName: "Garmin Dump",
            filePath: "/job-files/extracted/direct.fit",
          },
        }),
      ],
    });
    const flow: FlowJob | undefined = mockAdd.mock.calls[0]?.[0];
    expect(flow?.children?.[1]?.children).toBeUndefined();
  });

  it("rebuilds byte-for-byte identical IDs for the same upload plan", async () => {
    await attachGarminFitImportFlow(preparedImport, {
      id: "import-job-1",
      queue: "bull:import",
    });
    await attachGarminFitImportFlow(preparedImport, {
      id: "import-job-1",
      queue: "bull:import",
    });

    const firstFlow = mockAdd.mock.calls[0]?.[0];
    const secondFlow = mockAdd.mock.calls[1]?.[0];
    expect(secondFlow).toEqual(firstFlow);
  });

  it("seeds every deterministic ID with user, upload, and entry identity", async () => {
    const firstFitJobEntry = preparedImport.fitJobEntries[0];
    if (!firstFitJobEntry) {
      throw new Error("Expected the prepared import fixture to contain a FIT job");
    }
    const variants: PreparedGarminDumpImport[] = [
      preparedImport,
      { ...preparedImport, userId: "user-2" },
      { ...preparedImport, uploadPath: "/job-files/other-upload.zip" },
      {
        ...preparedImport,
        fitJobEntries: preparedImport.fitJobEntries.map((fitJobEntry, entryIndex) =>
          entryIndex === 0
            ? {
                ...firstFitJobEntry,
                entry: {
                  ...firstFitJobEntry.entry,
                  path: "nested/other-activity.fit",
                },
              }
            : fitJobEntry,
        ),
      },
    ].map((variant) => ({
      ...variant,
      batchId: createGarminFitBatchId(variant.uploadPath, variant.userId, variant.fitJobEntries),
    }));

    for (const variant of variants) {
      await attachGarminFitImportFlow(variant, {
        id: "import-job-1",
        queue: "bull:import",
      });
    }

    const flows: FlowJob[] = mockAdd.mock.calls.map(([flow]) => flow);
    const batchIds = flows.map((flow) => flow.opts?.jobId);
    const fitIds = flows.map((flow) => flow.children?.[0]?.opts?.jobId);
    const extractIds = flows.map((flow) => flow.children?.[0]?.children?.[0]?.opts?.jobId);
    expect(new Set(batchIds).size).toBe(variants.length);
    expect(new Set(fitIds).size).toBe(variants.length);
    expect(new Set(extractIds).size).toBe(variants.length);
    const allJobIds = [...batchIds, ...fitIds, ...extractIds];
    expect(allJobIds.every((jobId) => typeof jobId === "string" && !jobId.includes(":"))).toBe(
      true,
    );
  });

  it("keeps every FIT and extraction ID unique beyond the incident flow size", async () => {
    const fitJobEntries = Array.from({ length: 1_294 }, (_, entryIndex) => ({
      entry: {
        path: `nested/activity-${entryIndex}.fit`,
        archivePath: "/job-files/upload.zip",
        entryPath: ["nested.zip", `activity-${entryIndex}.fit`],
        outputDirectory: "/job-files/extracted",
        maxBytes: 128 * 1024 * 1024,
        nestedArchiveMaxBytes: 1024 * 1024 * 1024,
      },
      data: {
        originalPath: `nested/activity-${entryIndex}.fit`,
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      },
    }));

    await attachGarminFitImportFlow(
      { ...preparedImport, fitJobEntries, totalFitFiles: fitJobEntries.length },
      { id: "import-job-1", queue: "bull:import" },
    );

    const flows: FlowJob[] = mockAdd.mock.calls.map(([flow]) => flow);
    const allFitJobIds = flows.flatMap(
      (flow) => flow.children?.map((child) => child.opts?.jobId) ?? [],
    );
    const allExtractionJobIds = flows.flatMap(
      (flow) =>
        flow.children?.flatMap((child) => child.children?.map((c) => c.opts?.jobId) ?? []) ?? [],
    );
    expect(allFitJobIds).toHaveLength(1_294);
    expect(allExtractionJobIds).toHaveLength(1_294);
    expect(new Set(allFitJobIds).size).toBe(1_294);
    expect(new Set(allExtractionJobIds).size).toBe(1_294);

    expect(flows).toHaveLength(Math.ceil(1_294 / 500));
    const batchIds = flows.map((flow) => flow.opts?.jobId);
    expect(new Set(batchIds).size).toBe(flows.length);
  });
});
