import { describe, expect, it, vi } from "vitest";
import { purgeAccountWork } from "./work-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";

function makeJob(data: unknown, state: string, id?: string) {
  return {
    data,
    getState: vi.fn(async () => state),
    id,
    remove: vi.fn(async () => undefined),
  };
}

describe("purgeAccountWork", () => {
  it("removes attributable jobs, cache state, objects, and exact local paths", async () => {
    const userJob = makeJob({ userId, filePath: "/jobs/user/source.fit" }, "waiting", "job-erased");
    const otherJob = makeJob({ userId: "20000000-0000-4000-8000-000000001994" }, "waiting");
    const removeLocalPath = vi.fn(async () => undefined);
    const abortImportMultipart = vi.fn(async () => undefined);
    const deleteImportObject = vi.fn(async () => undefined);
    const deleteExportObject = vi.fn(async () => undefined);
    const purgeRedis = vi.fn(async () => undefined);

    await purgeAccountWork(
      {
        exportObjects: [
          {
            exportId: "30000000-0000-4000-8000-000000001994",
            objectKey: "exports/user/export.zip",
          },
        ],
        fileUploads: [
          {
            importJobId: "import-job",
            multipartUploadId: "multipart-1994",
            objectKey: "imports/user/archive.zip",
            uploadId: "40000000-0000-4000-8000-000000001994",
          },
        ],
        userId,
      },
      {
        abortImportMultipart,
        deleteExportObject,
        deleteImportObject,
        jobFilesDirectory: "/jobs",
        purgeRedis,
        queues: [{ getJobs: vi.fn(async () => [userJob, otherJob]), name: "import" }],
        removeLocalPath,
      },
    );

    expect(userJob.remove).toHaveBeenCalledWith({ removeChildren: true });
    expect(otherJob.remove).not.toHaveBeenCalled();
    expect(deleteImportObject).toHaveBeenCalledWith("imports/user/archive.zip");
    expect(abortImportMultipart).toHaveBeenCalledWith("imports/user/archive.zip", "multipart-1994");
    expect(deleteExportObject).toHaveBeenCalledWith("exports/user/export.zip");
    expect(removeLocalPath).toHaveBeenCalledWith("/jobs/user/source.fit");
    expect(removeLocalPath).toHaveBeenCalledWith(
      "/jobs/file-upload-40000000-0000-4000-8000-000000001994",
    );
    expect(removeLocalPath).toHaveBeenCalledWith(
      "/jobs/dofek-export-30000000-0000-4000-8000-000000001994.zip",
    );
    expect(purgeRedis).toHaveBeenCalledWith(userId, ["job-erased"]);
  });

  it("waits for an active attributable job before deleting its files", async () => {
    const activeJob = makeJob({ userId }, "active");
    const removeLocalPath = vi.fn(async () => undefined);

    await expect(
      purgeAccountWork(
        { exportObjects: [], fileUploads: [], userId },
        {
          abortImportMultipart: vi.fn(async () => undefined),
          deleteExportObject: vi.fn(async () => undefined),
          deleteImportObject: vi.fn(async () => undefined),
          jobFilesDirectory: "/jobs",
          purgeRedis: vi.fn(async () => undefined),
          queues: [{ getJobs: vi.fn(async () => [activeJob]), name: "sync" }],
          removeLocalPath,
        },
      ),
    ).rejects.toThrow("active account job");
    expect(removeLocalPath).not.toHaveBeenCalled();
  });

  it("rejects job paths outside the configured work directory", async () => {
    const job = makeJob({ userId, filePath: "/other-user/source.fit" }, "waiting");

    await expect(
      purgeAccountWork(
        { exportObjects: [], fileUploads: [], userId },
        {
          abortImportMultipart: vi.fn(async () => undefined),
          deleteExportObject: vi.fn(async () => undefined),
          deleteImportObject: vi.fn(async () => undefined),
          jobFilesDirectory: "/jobs",
          purgeRedis: vi.fn(async () => undefined),
          queues: [{ getJobs: vi.fn(async () => [job]), name: "fit-file-import" }],
          removeLocalPath: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("outside JOB_FILES_DIR");
  });

  it("finds nested user ownership and deletes deterministic queued export keys", async () => {
    const nestedJob = makeJob({ child: { payload: { userId } } }, "waiting");
    const deleteExportObject = vi.fn(async () => undefined);
    const exportId = "30000000-0000-4000-8000-000000001995";

    await purgeAccountWork(
      {
        exportObjects: [{ exportId, objectKey: null }],
        fileUploads: [],
        userId,
      },
      {
        abortImportMultipart: vi.fn(async () => undefined),
        deleteExportObject,
        deleteImportObject: vi.fn(async () => undefined),
        jobFilesDirectory: "/jobs",
        purgeRedis: vi.fn(async () => undefined),
        queues: [
          {
            getJobs: vi.fn(async () => [nestedJob]),
            name: "export",
          },
        ],
        removeLocalPath: vi.fn(async () => undefined),
      },
    );

    expect(nestedJob.remove).toHaveBeenCalledWith({ removeChildren: true });
    expect(deleteExportObject).toHaveBeenCalledWith(
      `exports/${userId}/${exportId}/dofek-export.zip`,
    );
  });

  it("finds nested flow ownership beyond the bounded queue page size", async () => {
    const unrelatedJobs = Array.from({ length: 105 }, (_, index) =>
      makeJob(
        {
          userId: "20000000-0000-4000-8000-000000001994",
          sequence: index,
        },
        "waiting",
      ),
    );
    const nestedFlowJob = makeJob(
      {
        children: [
          {
            payload: {
              userId,
            },
          },
        ],
      },
      "waiting",
    );
    const jobs = [...unrelatedJobs, nestedFlowJob];
    const getJobs = vi.fn(async (_states: readonly string[], start: number, end: number) =>
      jobs.slice(start, end + 1),
    );

    await purgeAccountWork(
      { exportObjects: [], fileUploads: [], userId },
      {
        abortImportMultipart: vi.fn(async () => undefined),
        deleteExportObject: vi.fn(async () => undefined),
        deleteImportObject: vi.fn(async () => undefined),
        jobFilesDirectory: "/jobs",
        purgeRedis: vi.fn(async () => undefined),
        queues: [{ getJobs, name: "flow" }],
        removeLocalPath: vi.fn(async () => undefined),
      },
    );

    expect(getJobs).toHaveBeenNthCalledWith(1, expect.any(Array), 0, 99, true);
    expect(getJobs).toHaveBeenNthCalledWith(2, expect.any(Array), 100, 199, true);
    expect(nestedFlowJob.remove).toHaveBeenCalledWith({
      removeChildren: true,
    });
  });

  it("repeats queue discovery until a final pass finds no new account work", async () => {
    const firstJob = makeJob({ userId }, "waiting");
    const racedJob = makeJob({ nested: { userId } }, "delayed");
    const pages = [[firstJob], [racedJob], []];
    const getJobs = vi.fn(async () => pages.shift() ?? []);

    await purgeAccountWork(
      { exportObjects: [], fileUploads: [], userId },
      {
        abortImportMultipart: vi.fn(async () => undefined),
        deleteExportObject: vi.fn(async () => undefined),
        deleteImportObject: vi.fn(async () => undefined),
        jobFilesDirectory: "/jobs",
        purgeRedis: vi.fn(async () => undefined),
        queues: [{ getJobs, name: "sync-provider" }],
        removeLocalPath: vi.fn(async () => undefined),
      },
    );

    expect(firstJob.remove).toHaveBeenCalledOnce();
    expect(racedJob.remove).toHaveBeenCalledOnce();
    expect(getJobs).toHaveBeenCalledTimes(3);
  });

  it("fails closed on a non-JSON BullMQ payload", async () => {
    const malformedJob = makeJob({ userId, invalid: () => undefined }, "waiting");

    await expect(
      purgeAccountWork(
        { exportObjects: [], fileUploads: [], userId },
        {
          abortImportMultipart: vi.fn(async () => undefined),
          deleteExportObject: vi.fn(async () => undefined),
          deleteImportObject: vi.fn(async () => undefined),
          jobFilesDirectory: "/jobs",
          purgeRedis: vi.fn(async () => undefined),
          queues: [
            {
              getJobs: vi.fn(async () => [malformedJob]),
              name: "import",
            },
          ],
          removeLocalPath: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow(
      "Account erasure cannot prove ownership of malformed BullMQ job data in import",
    );
    expect(malformedJob.remove).not.toHaveBeenCalled();
  });
});
