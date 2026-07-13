import { describe, expect, it } from "vitest";
import { processFitFileImportBatchJob } from "./process-fit-file-import-batch-job.ts";

describe("processFitFileImportBatchJob", () => {
  it("aggregates records and errors from child FIT import jobs", async () => {
    const result = await processFitFileImportBatchJob({
      getChildrenValues: async () => ({
        "bull:fit-file-import:1": { recordsSynced: 2, errors: [] },
        "bull:fit-file-import:2": {
          recordsSynced: 1,
          errors: [{ message: "bad fit" }],
        },
      }),
    });

    expect(result).toEqual({
      recordsSynced: 3,
      errors: [{ message: "bad fit" }],
    });
  });

  it("rejects malformed child results", async () => {
    await expect(
      processFitFileImportBatchJob({
        getChildrenValues: async () => ({
          "bull:fit-file-import:1": { recordsSynced: "2", errors: [] },
        }),
      }),
    ).rejects.toThrow();
  });
});
