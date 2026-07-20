import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/typed-sql.ts";

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(),
  markDispatched: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  listPendingFileUploadOutboxRequests: mocks.listPending,
  markFileUploadOutboxDispatched: mocks.markDispatched,
}));

import { dispatchFileUploadOutbox } from "./file-upload-outbox.ts";

describe("dispatchFileUploadOutbox", () => {
  it("retries a committed outbox event with one deterministic logical job", async () => {
    const uploadId = "00000000-0000-4000-8000-0000000000f1";
    const request = {
      uploadId,
      importJobId: `file-import-${uploadId}`,
      importType: "garmin-dump",
      userId: "00000000-0000-4000-8000-0000000000f2",
    };
    mocks.listPending.mockResolvedValue([request]);
    mocks.markDispatched.mockResolvedValue(undefined);
    const database = { execute: vi.fn(async () => []) } satisfies Pick<Database, "execute">;
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockResolvedValueOnce({ id: request.importJobId }),
    };

    await expect(dispatchFileUploadOutbox(database, queue)).rejects.toThrow("Redis unavailable");
    await expect(dispatchFileUploadOutbox(database, queue)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "garmin-dump",
      expect.objectContaining({ uploadId }),
      { jobId: request.importJobId },
    );
    expect(mocks.markDispatched).toHaveBeenCalledOnce();
  });
});
