import { describe, expect, it, vi } from "vitest";
import {
  type FileUploadApi,
  runMobileResumableFileUpload,
  type UploadableMobileFile,
} from "./resumable-file-upload";

const uploadId = "4ad58c4c-2a3d-4c49-9919-2f15ab0b1f70";

function api(): FileUploadApi {
  return {
    initiate: vi.fn(async () => ({ uploadId, partSizeBytes: 16 * 1024 * 1024 })),
    authorizeParts: vi.fn(async () => ({
      parts: [
        {
          partNumber: 1,
          url: "https://r2.example/part-1",
          expiresAt: "2026-08-27T20:00:00.000Z",
        },
      ],
    })),
    complete: vi.fn(async () => ({ uploadId, importJobId: `file-import-${uploadId}` })),
    resume: vi.fn(async () => ({ upload: { uploadId, state: "uploading" }, parts: [] })),
  };
}

describe("runMobileResumableFileUpload", () => {
  it("uploads a shared file through its native URI without fetch or Blob", async () => {
    const uploadPart = vi.fn(async () => ({ status: 200, headers: { etag: "etag-1" } }));
    const file: UploadableMobileFile = {
      uri: "file:///tmp/Strong%20Export.csv",
      name: "Strong Export.csv",
      type: "text/csv",
      size: 8,
      sha256: vi.fn(async () => "a".repeat(64)),
      uploadPart,
    };
    const uploadApi = api();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMobileResumableFileUpload({
      api: uploadApi,
      file,
      importType: "strong-csv",
      onProgress: vi.fn(),
      createUploadId: () => uploadId,
    });

    expect(uploadPart).toHaveBeenCalledWith({
      offset: 0,
      length: 8,
      url: "https://r2.example/part-1",
      onProgress: expect.any(Function),
    });
    expect(uploadApi.complete).toHaveBeenCalledWith({
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });
    expect(result).toEqual({ uploadId, importJobId: `file-import-${uploadId}` });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
