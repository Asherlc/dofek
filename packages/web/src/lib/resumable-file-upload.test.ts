// @vitest-environment jsdom
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FileUploadApi,
  hashFile,
  indexedDbUploadSessionStore,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("hashes files in chunks and reports percentage progress", async () => {
    const progress = vi.fn();
    const contents = "hash me";

    await expect(hashFile(new File([contents], "data.txt"), progress)).resolves.toBe(
      createHash("sha256").update(contents).digest("hex"),
    );
    expect(progress).toHaveBeenCalledWith(100);
  });

  it("hashes large files using bounded chunks without requiring a progress callback", async () => {
    const chunkSize = 4 * 1024 * 1024;
    const file = new File([new Uint8Array(chunkSize + 3)], "large.fit");
    const slice = vi.spyOn(file, "slice");

    await expect(hashFile(file)).resolves.toBe(
      createHash("sha256")
        .update(new Uint8Array(chunkSize + 3))
        .digest("hex"),
    );
    expect(slice).toHaveBeenNthCalledWith(1, 0, chunkSize);
    expect(slice).toHaveBeenNthCalledWith(2, chunkSize, chunkSize + 3);
    expect(slice).toHaveBeenCalledTimes(2);
  });

  it("stops hashing when the upload is cancelled", async () => {
    const controller = new AbortController();
    const chunkSize = 4 * 1024 * 1024;
    const file = new File([new Uint8Array(chunkSize + 1)], "large.fit");
    const slice = vi.spyOn(file, "slice");

    await expect(hashFile(file, () => controller.abort(), controller.signal)).rejects.toMatchObject(
      { name: "AbortError", message: "Upload cancelled" },
    );
    expect(slice).toHaveBeenCalledOnce();
  });

  it.each([
    ["filename", "different.fit"],
    ["sizeBytes", 9],
    ["lastModified", 999],
    ["sha256", "b".repeat(64)],
  ])("starts a new upload when the stored session has a different %s", async (field, value) => {
    const storedUploadId = randomUUID();
    const newUploadId = randomUUID();
    const file = new File(["abcdefgh"], "activity.fit", { lastModified: 456 });
    const storedSession: StoredUploadSession = {
      providerId: "fit-file",
      uploadId: storedUploadId,
      importType: "fit-file",
      filename: file.name,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      sha256: createHash("sha256").update("abcdefgh").digest("hex"),
      partSizeBytes: 5,
      completedParts: [],
      [field]: value,
    };
    const api = uploadApi(newUploadId);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(newUploadId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { etag: "etag" } })),
    );

    await runResumableFileUpload({
      api,
      file,
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: memoryStore(storedSession),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(api.initiate).toHaveBeenCalledWith(expect.objectContaining({ uploadId: newUploadId }));
    expect(api.resume).toHaveBeenCalledWith({ uploadId: newUploadId });
  });

  it("starts a new Strong upload when the selected weight unit changes", async () => {
    const storedUploadId = randomUUID();
    const newUploadId = randomUUID();
    const file = new File(["abcdefgh"], "strong.csv", { lastModified: 456 });
    const storedSession: StoredUploadSession = {
      providerId: "strong-csv",
      uploadId: storedUploadId,
      importType: "strong-csv",
      filename: file.name,
      sizeBytes: file.size,
      lastModified: file.lastModified,
      sha256: createHash("sha256").update("abcdefgh").digest("hex"),
      partSizeBytes: 5,
      completedParts: [],
      weightUnit: "kg",
    };
    const api = uploadApi(newUploadId);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(newUploadId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { etag: "etag" } })),
    );

    await runResumableFileUpload({
      api,
      file,
      importType: "strong-csv",
      providerId: "strong-csv",
      sessionStore: memoryStore(storedSession),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      weightUnit: "lbs",
    });

    expect(api.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: newUploadId, weightUnit: "lbs" }),
    );
    expect(api.resume).toHaveBeenCalledWith({ uploadId: newUploadId });
  });

  it("uploads exact part boundaries and persists sorted completion progress", async () => {
    const uploadId = randomUUID();
    const api = uploadApi(uploadId);
    const store = memoryStore();
    const uploadedBodies: string[] = [];
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uploadId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, request: RequestInit) => {
        if (!(request.body instanceof Blob)) throw new Error("Expected upload body to be a Blob");
        const uploadedBody = new TextDecoder().decode(await request.body.arrayBuffer());
        uploadedBodies.push(uploadedBody);
        if (uploadedBody === "fgh") await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response(null, {
          status: 200,
          headers: { etag: `etag-${uploadedBodies.length}` },
        });
      }),
    );
    const onProgress = vi.fn();

    await runResumableFileUpload({
      api,
      file: new File(["abcdefgh"], "activity.fit"),
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: store,
      signal: new AbortController().signal,
      onProgress,
    });

    expect(uploadedBodies.sort()).toEqual(["abcde", "fgh"]);
    expect(api.authorizeParts).toHaveBeenCalledWith({ uploadId, partNumbers: [1] });
    expect(api.authorizeParts).toHaveBeenCalledWith({ uploadId, partNumbers: [2] });
    expect(onProgress).toHaveBeenCalledWith({
      phase: "uploading",
      percentage: 48,
      message: "Uploaded 1 of 2 parts",
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: "uploading",
      percentage: 85,
      message: "Uploaded 2 of 2 parts",
    });
    expect(api.complete).toHaveBeenCalledWith({
      uploadId,
      parts: [
        { partNumber: 1, etag: expect.stringMatching(/^etag-/) },
        { partNumber: 2, etag: expect.stringMatching(/^etag-/) },
      ],
    });
  });

  it("cancels a retry while it is waiting to back off", async () => {
    const controller = new AbortController();
    const api = uploadApi(randomUUID());
    vi.spyOn(Math, "random").mockReturnValue(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(null, { status: 503 });
      }),
    );

    await expect(
      runResumableFileUpload({
        api,
        file: new File(["abc"], "activity.fit"),
        importType: "fit-file",
        providerId: "fit-file",
        sessionStore: memoryStore(),
        signal: controller.signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Upload cancelled" });
    expect(api.authorizeParts).toHaveBeenCalledOnce();
  });

  it("starts a fresh upload with fallback content type and reports every phase", async () => {
    const uploadId = randomUUID();
    const staleUploadId = randomUUID();
    const file = new File(["abcdefgh"], "activity.fit", { lastModified: 456 });
    const store = memoryStore({
      providerId: "fit-file",
      uploadId: staleUploadId,
      importType: "fit-file",
      filename: "different.fit",
      sizeBytes: file.size,
      lastModified: file.lastModified,
      sha256: "a".repeat(64),
      partSizeBytes: 5,
      completedParts: [],
    });
    const api = uploadApi(uploadId);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uploadId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, request: RequestInit) => {
        expect(request.method).toBe("PUT");
        expect(request.signal).toBeInstanceOf(AbortSignal);
        return new Response(null, { status: 200, headers: { etag: "etag" } });
      }),
    );
    const onProgress = vi.fn();

    await runResumableFileUpload({
      api,
      file,
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: store,
      signal: new AbortController().signal,
      onProgress,
      fullSync: true,
      weightUnit: "lbs",
    });

    expect(api.initiate).toHaveBeenCalledWith({
      uploadId,
      importType: "fit-file",
      filename: "activity.fit",
      contentType: "application/octet-stream",
      sizeBytes: 8,
      sha256: createHash("sha256").update("abcdefgh").digest("hex"),
      fullSync: true,
      weightUnit: "lbs",
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: "preparing",
      percentage: 0,
      message: "Preparing upload...",
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: "verifying",
      percentage: 90,
      message: "Verifying upload...",
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: "queueing",
      percentage: 95,
      message: "Queueing import...",
    });
  });

  it("completes immediately when every server part is already uploaded", async () => {
    const uploadId = randomUUID();
    const api = uploadApi(uploadId, [
      { partNumber: 2, etag: "two", sizeBytes: 3 },
      { partNumber: 1, etag: "one", sizeBytes: 5 },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runResumableFileUpload({
      api,
      file: new File(["abcdefgh"], "activity.fit"),
      importType: "fit-file",
      providerId: "fit-file",
      sessionStore: memoryStore(),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.complete).toHaveBeenCalledWith({
      uploadId: expect.any(String),
      parts: [
        { partNumber: 1, etag: "one" },
        { partNumber: 2, etag: "two" },
      ],
    });
  });

  it("retries missing authorizations five times and leaves the session resumable", async () => {
    const uploadId = randomUUID();
    const api = uploadApi(uploadId);
    api.authorizeParts.mockResolvedValue({ parts: [] });
    const store = memoryStore();
    vi.spyOn(Math, "random").mockReturnValue(0);

    await expect(
      runResumableFileUpload({
        api,
        file: new File(["abc"], "activity.fit"),
        importType: "fit-file",
        providerId: "fit-file",
        sessionStore: store,
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow("Part 1 authorization was not returned");

    expect(api.authorizeParts).toHaveBeenCalledTimes(5);
    expect(api.complete).not.toHaveBeenCalled();
    expect(store.value?.uploadId).toBeDefined();
  });

  it("rejects cancellation before a part request", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = uploadApi(randomUUID());

    await expect(
      runResumableFileUpload({
        api,
        file: new File(["abc"], "activity.fit"),
        importType: "fit-file",
        providerId: "fit-file",
        sessionStore: memoryStore(),
        signal: controller.signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Upload cancelled" });
    expect(api.authorizeParts).not.toHaveBeenCalled();
  });
});

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeOpenRequest {
  result?: unknown;
  error: Error | null;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function fakeRequest(result: unknown, error: Error | null = null): FakeRequest {
  const request: FakeRequest = { result, error, onsuccess: null, onerror: null };
  queueMicrotask(() => (error ? request.onerror?.() : request.onsuccess?.()));
  return request;
}

function installIndexedDb(value: unknown, requestError: Error | null = null) {
  const close = vi.fn();
  const createObjectStore = vi.fn();
  const get = vi.fn(() => fakeRequest(value, requestError));
  const put = vi.fn(() => fakeRequest(undefined, requestError));
  const deleteValue = vi.fn(() => fakeRequest(undefined, requestError));
  const objectStore = vi.fn(() => ({ get, put, delete: deleteValue }));
  const transaction = vi.fn(() => ({ objectStore }));
  const database = { close, createObjectStore, transaction };
  const openRequest: FakeOpenRequest = {
    result: database,
    error: null,
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
  };
  const open = vi.fn(() => {
    queueMicrotask(() => {
      openRequest.onupgradeneeded?.();
      openRequest.onsuccess?.();
    });
    return openRequest;
  });
  vi.stubGlobal("indexedDB", { open });
  return { close, createObjectStore, deleteValue, get, open, put, transaction };
}

describe("indexedDbUploadSessionStore", () => {
  const session: StoredUploadSession = {
    providerId: "fit-file",
    uploadId: "00000000-0000-4000-8000-000000000001",
    importType: "fit-file",
    filename: "activity.fit",
    sizeBytes: 3,
    lastModified: 123,
    sha256: "a".repeat(64),
    partSizeBytes: 5,
    completedParts: [{ partNumber: 1, etag: "etag" }],
    weightUnit: "lbs",
  };

  it("creates the session store and reads validated sessions", async () => {
    const fakeDatabase = installIndexedDb(session);

    await expect(indexedDbUploadSessionStore.get("fit-file")).resolves.toEqual(session);
    expect(fakeDatabase.open).toHaveBeenCalledWith("dofek-file-uploads", 1);
    expect(fakeDatabase.createObjectStore).toHaveBeenCalledWith("sessions");
    expect(fakeDatabase.transaction).toHaveBeenCalledWith("sessions", "readonly");
    expect(fakeDatabase.get).toHaveBeenCalledWith("fit-file");
    expect(fakeDatabase.close).toHaveBeenCalledOnce();
  });

  it("maps a missing session to null", async () => {
    installIndexedDb(undefined);
    await expect(indexedDbUploadSessionStore.get("fit-file")).resolves.toBeNull();
  });

  it("writes and deletes sessions in read-write transactions", async () => {
    const fakeDatabase = installIndexedDb(undefined);

    await indexedDbUploadSessionStore.put(session);
    await indexedDbUploadSessionStore.delete("fit-file");

    expect(fakeDatabase.transaction).toHaveBeenNthCalledWith(1, "sessions", "readwrite");
    expect(fakeDatabase.transaction).toHaveBeenNthCalledWith(2, "sessions", "readwrite");
    expect(fakeDatabase.put).toHaveBeenCalledWith(session, "fit-file");
    expect(fakeDatabase.deleteValue).toHaveBeenCalledWith("fit-file");
    expect(fakeDatabase.close).toHaveBeenCalledTimes(2);
  });

  it("closes the database when stored data or requests are invalid", async () => {
    const invalidDatabase = installIndexedDb({ providerId: "fit-file" });
    await expect(indexedDbUploadSessionStore.get("fit-file")).rejects.toThrow();
    expect(invalidDatabase.close).toHaveBeenCalledOnce();

    const failingDatabase = installIndexedDb(undefined, new Error("request failed"));
    await expect(indexedDbUploadSessionStore.get("fit-file")).rejects.toThrow("request failed");
    expect(failingDatabase.close).toHaveBeenCalledOnce();
  });

  it("reports IndexedDB open failures", async () => {
    const openRequest: FakeOpenRequest = {
      error: new Error("open failed"),
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => {
        queueMicrotask(() => openRequest.onerror?.());
        return openRequest;
      }),
    });

    await expect(indexedDbUploadSessionStore.get("fit-file")).rejects.toThrow("open failed");
  });
});
