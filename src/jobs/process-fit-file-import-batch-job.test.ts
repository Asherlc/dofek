import { describe, expect, it } from "vitest";
import { processFitFileImportBatchJob } from "./process-fit-file-import-batch-job.ts";

describe("processFitFileImportBatchJob", () => {
  it("preserves successful records and groups completed and ignored child failures", async () => {
    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({
        "bull:fit-file-import:1": { recordsSynced: 2, errors: [] },
        "bull:fit-file-import:2": {
          recordsSynced: 1,
          errors: [
            {
              message: "Failed to import FIT file archive/old.fit: FIT decoder reported 1 errors",
            },
          ],
        },
      }),
      getIgnoredChildrenFailures: async () => ({
        "bull:fit-file-import:3":
          "Failed to import FIT file archive/one.fit: FIT decoder reported 1 errors",
        "bull:fit-file-import:4":
          "UnrecoverableError: Failed to import FIT file archive/two.fit:\n FIT decoder reported 1 errors",
        "bull:fit-file-import:5": "database connection reset",
      }),
    });

    expect(result).toEqual({
      recordsSynced: 3,
      errors: [
        { message: "3 FIT files failed: FIT decoder reported 1 errors" },
        { message: "1 FIT file failed: database connection reset" },
      ],
    });
  });

  it("returns an empty result when the batch has no child values", async () => {
    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({}),
      getIgnoredChildrenFailures: async () => ({}),
    });

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
  });

  it("caps aggregate errors at ten entries and summarizes every omitted failure", async () => {
    const ignoredFailures = Object.fromEntries(
      Array.from({ length: 12 }, (_, failureIndex) => [
        `bull:fit-file-import:${failureIndex}`,
        `Failed to import FIT file archive/${failureIndex}.fit: cause ${String(
          failureIndex,
        ).padStart(2, "0")}`,
      ]),
    );

    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({
        "bull:fit-file-import:success": { recordsSynced: 7, errors: [] },
      }),
      getIgnoredChildrenFailures: async () => ignoredFailures,
    });

    expect(result.recordsSynced).toBe(7);
    expect(result.errors).toHaveLength(10);
    expect(result.errors.slice(0, 9)).toEqual(
      Array.from({ length: 9 }, (_, failureIndex) => ({
        message: `1 FIT file failed: cause ${String(failureIndex).padStart(2, "0")}`,
      })),
    );
    expect(result.errors[9]).toEqual({
      message: "3 additional FIT file failures across 3 causes omitted",
    });
  });

  it("normalizes only leading BullMQ wrappers and repeated whitespace", async () => {
    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({}),
      getIgnoredChildrenFailures: async () => ({
        "bull:fit-file-import:1":
          "UnrecoverableError:   Failed to import FIT file archive/one.fit:   decoder\n\tfailed   badly  ",
        "bull:fit-file-import:2": "context UnrecoverableError: nested failure",
        "bull:fit-file-import:3": "context Failed to import FIT file nested.fit: failure",
      }),
    });

    expect(result.errors).toEqual([
      { message: "1 FIT file failed: context Failed to import FIT file nested.fit: failure" },
      { message: "1 FIT file failed: context UnrecoverableError: nested failure" },
      { message: "1 FIT file failed: decoder failed badly" },
    ]);
  });

  it("sorts failure groups by count and then cause", async () => {
    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({}),
      getIgnoredChildrenFailures: async () => ({
        "bull:fit-file-import:1": "zulu",
        "bull:fit-file-import:2": "beta",
        "bull:fit-file-import:3": "alpha",
        "bull:fit-file-import:4": "beta",
      }),
    });

    expect(result.errors).toEqual([
      { message: "2 FIT files failed: beta" },
      { message: "1 FIT file failed: alpha" },
      { message: "1 FIT file failed: zulu" },
    ]);
  });

  it("keeps exactly ten distinct failure groups without an omission summary", async () => {
    const ignoredFailures = Object.fromEntries(
      Array.from({ length: 10 }, (_, failureIndex) => [
        `bull:fit-file-import:${failureIndex}`,
        `cause ${String(failureIndex).padStart(2, "0")}`,
      ]),
    );

    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({}),
      getIgnoredChildrenFailures: async () => ignoredFailures,
    });

    expect(result.errors).toHaveLength(10);
    expect(result.errors.at(-1)).toEqual({ message: "1 FIT file failed: cause 09" });
  });

  it("rejects malformed child results", async () => {
    await expect(
      processFitFileImportBatchJob({
        getChildrenValues: async () => ({
          "bull:fit-file-import:1": { recordsSynced: "2", errors: [] },
        }),
        getIgnoredChildrenFailures: async () => ({}),
      }),
    ).rejects.toThrow();
  });
});
