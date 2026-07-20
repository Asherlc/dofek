// @vitest-environment jsdom
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FileUploadApi,
  runResumableFileUpload,
  type StoredUploadSession,
  type UploadSessionStore,
} from "./resumable-file-upload.ts";

function summary(uploadId: string) {
  return {
    uploadId,
    state: "uploading",
    partSizeBytes: 5,
    importJobId: null,
    progressPercent: 0,
    errorMessage: null,
  };
}

function memoryStore(initial: StoredUploadSession | null = null): UploadSessionStore & {
  value: StoredUploadSession | null;
} {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async put(session) {
      this.value = structuredClone(session);
    },
    async delete() {
      this.value = null;
    },
  };
}

function uploadApi(
  uploadId: string,
  resumedParts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [],
) {
  return {
    abort: vi.fn(),
    initiate: vi.fn(async () => summary(uploadId)),
    authorizeParts: vi.fn(async ({ partNumbers }: { partNumbers: number[] }) => ({
      parts: partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://upload.example/${partNumber}/${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    })),
    resume: vi.fn(async () => ({ upload: summary(uploadId), parts: resumedParts })),
    complete: vi.fn(async () => ({
      ...summary(uploadId),
      state: "queued",
      importJobId: `file-import-${uploadId}`,
    })),
  } satisfies FileUploadApi;
}

afterEach(() => vi.unstubAllGlobals());

describe("runResumableFileUpload", () => {
  it("retries a failed part with renewed authorization and completes once", async () => {
    const uploadId = randomUUID();
    const api = uploadApi(uploadId);
    const store = memoryStore();
    let requestCount = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestCount++;
        if (requestCount === 1) return new Response(null, { status: 503 });
        return new Response(null, { status: 200, headers: { etag: `etag-${requestCount}` } });
      }),
    );

    await runResumableFileUpload({
      api,
      file: new File(["abcdefgh"], "activity.fit", { type: "application/octet-stream" }),
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: store,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(api.authorizeParts).toHaveBeenCalledTimes(3);
    expect(api.complete).toHaveBeenCalledOnce();
    expect(store.value).toBeNull();
  });

  it("resumes after refresh without uploading server-confirmed parts", async () => {
    const uploadId = randomUUID();
    const contents = "abcdefgh";
    const file = new File([contents], "activity.fit", {
      type: "application/octet-stream",
      lastModified: 123,
    });
    const api = uploadApi(uploadId, [{ partNumber: 1, etag: "existing-etag", sizeBytes: 5 }]);
    const store = memoryStore({
      providerId: "fit-file",
      uploadId,
      importType: "fit-file",
      filename: file.name,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      sha256: createHash("sha256").update(contents).digest("hex"),
      partSizeBytes: 5,
      completedParts: [{ partNumber: 1, etag: "existing-etag" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { etag: "new-etag" } })),
    );

    await runResumableFileUpload({
      api,
      file,
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: store,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(api.initiate).toHaveBeenCalledWith(expect.objectContaining({ uploadId }));
    expect(api.authorizeParts).toHaveBeenCalledWith({ uploadId, partNumbers: [2] });
    expect(api.complete).toHaveBeenCalledWith({
      uploadId,
      parts: [
        { partNumber: 1, etag: "existing-etag" },
        { partNumber: 2, etag: "new-etag" },
      ],
    });
  });
});
