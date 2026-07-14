import { describe, expect, it, vi } from "vitest";
import {
  type ImportProviderId,
  importSharedFile,
  inferImportProviderFromFile,
} from "./share-import";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("inferImportProviderFromFile", () => {
  it("detects Strong CSV by header", () => {
    const provider = inferImportProviderFromFile({
      fileName: "export.csv",
      fileExtension: ".csv",
      mimeType: "text/csv",
      csvHeaderLine: "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps",
    });
    expect(provider).toBe("strong-csv");
  });

  it("detects Cronometer CSV by filename when header is missing", () => {
    const provider = inferImportProviderFromFile({
      fileName: "Cronometer_Servings.csv",
      fileExtension: ".csv",
      mimeType: "text/csv",
      csvHeaderLine: "",
    });
    expect(provider).toBe("cronometer-csv");
  });

  it("detects Apple Health from zip extension", () => {
    const provider = inferImportProviderFromFile({
      fileName: "export.zip",
      fileExtension: ".zip",
      mimeType: "application/zip",
      csvHeaderLine: "",
    });
    expect(provider).toBe("apple-health");
  });

  it("detects Garmin dump before generic zip handling", () => {
    const provider = inferImportProviderFromFile({
      fileName: "garmin-export.zip",
      fileExtension: ".zip",
      mimeType: "application/zip",
      csvHeaderLine: "",
    });
    expect(provider).toBe("garmin-dump");
  });

  it("detects a generic FIT file by extension", () => {
    const provider = inferImportProviderFromFile({
      fileName: "morning-ride.fit",
      fileExtension: ".fit",
      mimeType: "application/octet-stream",
      csvHeaderLine: "",
    });
    expect(provider).toBe("fit-file");
  });

  it("detects Kaya CSV by filename", () => {
    const provider = inferImportProviderFromFile({
      fileName: "kaya-export.csv",
      fileExtension: ".csv",
      mimeType: "text/csv",
      csvHeaderLine: "Date,Climb,Grade",
    });
    expect(provider).toBe("kaya-export");
  });
});

describe("importSharedFile", () => {
  it("uploads a FIT file to the generic FIT provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const customReadBlob = vi
      .fn()
      .mockResolvedValue(new Blob(["fit-data"], { type: "application/octet-stream" }));

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-fit" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/morning-ride.fit",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
        now: () => 321,
      },
    );

    expect(result).toEqual({ providerId: "fit-file", jobId: "job-fit" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://example.com/api/upload/fit-file",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "x-file-ext": ".fit",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://example.com/api/upload/fit-file/status/job-fit",
      expect.anything(),
    );
  });

  it("uploads an explicitly selected Garmin dump ZIP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const customReadBlob = vi
      .fn()
      .mockResolvedValue(new Blob(["garmin-export"], { type: "application/zip" }));

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-garmin" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "processing", progress: 64, message: "Importing activities" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const progressMessages: string[] = [];
    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/export.zip",
        providerId: "garmin-dump",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
        onProgress: (progress) => progressMessages.push(progress.message),
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
        now: () => 123,
      },
    );

    expect(result).toEqual({ providerId: "garmin-dump", jobId: "job-garmin" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://example.com/api/upload/garmin-dump",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "Content-Type": "application/octet-stream",
          "x-upload-id": expect.stringMatching(/^share-123-/),
          "x-chunk-index": "0",
          "x-chunk-total": "1",
          "x-file-ext": ".zip",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://example.com/api/upload/garmin-dump/status/job-garmin",
      expect.anything(),
    );
    expect(progressMessages).toContain("Importing activities");
  });

  it("splits large Garmin dumps into shared upload chunks", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const chunkSize = 50 * 1024 * 1024;
    const largeBlob = new Blob(["garmin-export"], { type: "application/zip" });
    Object.defineProperty(largeBlob, "size", { value: chunkSize + 1 });
    const slice = vi
      .spyOn(largeBlob, "slice")
      .mockImplementation(() => new Blob(["chunk"], { type: "application/octet-stream" }));
    const customReadBlob = vi.fn().mockResolvedValue(largeBlob);

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "uploading", jobId: "large-upload" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "assembling", jobId: "large-upload" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/garmin-export.zip",
        providerId: "garmin-dump",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
        now: () => 999,
      },
    );

    expect(result).toEqual({ providerId: "garmin-dump", jobId: "large-upload" });
    expect(slice).toHaveBeenNthCalledWith(1, 0, chunkSize);
    expect(slice).toHaveBeenNthCalledWith(2, chunkSize, chunkSize + 1);
    const firstChunkHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    const secondChunkHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(firstChunkHeaders.get("x-upload-id")).toMatch(/^share-999-/);
    expect(secondChunkHeaders.get("x-upload-id")).toBe(firstChunkHeaders.get("x-upload-id"));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://example.com/api/upload/garmin-dump",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-chunk-index": "0",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://example.com/api/upload/garmin-dump",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-chunk-index": "1",
          "x-chunk-total": "2",
          "x-file-ext": ".zip",
        }),
      }),
    );
  });

  it("uploads a Strong CSV and polls until done", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";

    fetchImpl
      .mockResolvedValueOnce(
        new Response(fileBody, {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", progress: 50 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const seenStatuses: string[] = [];
    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/Strong%20Export.csv",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
        onProgress: (state) => {
          seenStatuses.push(state.status);
        },
      },
      {
        fetchImpl,
        sleep: async () => {},
        now: () => 456,
      },
    );

    expect(result.providerId).toBe<ImportProviderId>("strong-csv");
    expect(result.jobId).toBe("job-123");
    expect(seenStatuses).toContain("uploading");
    expect(seenStatuses).toContain("processing");
    expect(seenStatuses).toContain("done");

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://example.com/api/upload/strong-csv?units=kg",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "Content-Type": "application/octet-stream",
          "x-upload-id": expect.stringMatching(/^share-456-/),
          "x-chunk-index": "0",
          "x-chunk-total": "1",
          "x-file-ext": ".csv",
        }),
      }),
    );
  });

  it("uploads an explicitly selected Kaya CSV through the shared chunked path", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Climb,Grade\n2026-03-10,Test Boulder,V5";
    const customReadBlob = vi.fn().mockResolvedValue(new Blob([fileBody], { type: "text/csv" }));

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-kaya" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/kaya-export.csv",
        providerId: "kaya-export",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
        now: () => 567,
      },
    );

    expect(result).toEqual({ providerId: "kaya-export", jobId: "job-kaya" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://example.com/api/upload/kaya-export",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "Content-Type": "application/octet-stream",
          "x-upload-id": expect.stringMatching(/^share-567-/),
          "x-chunk-index": "0",
          "x-chunk-total": "1",
          "x-file-ext": ".csv",
        }),
      }),
    );
  });

  it("uses custom readBlob dep when provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";
    const customReadBlob = vi.fn().mockResolvedValue(new Blob([fileBody], { type: "text/csv" }));

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-456" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/Strong%20Export.csv",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
      },
    );

    expect(result.providerId).toBe<ImportProviderId>("strong-csv");
    expect(customReadBlob).toHaveBeenCalledWith("file:///tmp/Strong%20Export.csv");
    // fetchImpl should NOT be called for reading the file — only for upload + status poll
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("handles csv blobs without text() by falling back to arrayBuffer()", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";
    const customReadBlob = vi.fn().mockImplementation(async () => {
      const blob = new Blob([fileBody], { type: "text/csv" });
      Object.defineProperty(blob, "text", { value: undefined });
      return blob;
    });

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-789" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/export.csv",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
      },
    );

    expect(result.providerId).toBe<ImportProviderId>("strong-csv");
    expect(result.jobId).toBe("job-789");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws for unsupported file extension", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new Response("test", { status: 200 }));

    await expect(
      importSharedFile(
        {
          fileUri: "file:///tmp/export.json",
          serverUrl: "https://example.com",
          sessionToken: "session-token",
        },
        { fetchImpl, sleep: async () => {} },
      ),
    ).rejects.toThrow("Unsupported shared file type");
  });

  it("falls back to fetch when blob.text and blob.arrayBuffer throw errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";

    const customReadBlob = vi.fn().mockImplementation(async () => {
      const blob = new Blob([fileBody], { type: "text/csv" });
      Object.defineProperty(blob, "text", {
        value: () => {
          throw new Error("creating blobs from arraybuffer or arraybufferview are not supported");
        },
      });
      Object.defineProperty(blob, "arrayBuffer", {
        value: () => {
          throw new Error("creating blobs from arraybuffer or arraybufferview are not supported");
        },
      });
      return blob;
    });

    // The fetchImpl needs to handle both the initial file read AND the upload/status polls
    fetchImpl
      // 1. Initial file read fallback
      .mockResolvedValueOnce(new Response(fileBody, { status: 200 }))
      // 2. Upload request
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-fallback" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // 3. Status poll
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await importSharedFile(
      {
        fileUri: "file:///tmp/fallback.csv",
        serverUrl: "https://example.com",
        sessionToken: "session-token",
      },
      {
        fetchImpl,
        readBlob: customReadBlob,
        sleep: async () => {},
      },
    );

    expect(result.providerId).toBe<ImportProviderId>("strong-csv");
    expect(result.jobId).toBe("job-fallback");
    // fetchImpl called 3 times: fallback read, upload, poll
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "file:///tmp/fallback.csv");
  });

  it("does not report non-json status errors as json parse failures", async () => {
    mockCaptureException.mockClear();
    const fetchImpl = vi.fn<typeof fetch>();
    const fileBody = "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";
    const customReadBlob = vi.fn().mockResolvedValue(new Blob([fileBody], { type: "text/csv" }));

    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", jobId: "job-html-error" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      );

    await expect(
      importSharedFile(
        {
          fileUri: "file:///tmp/export.csv",
          serverUrl: "https://example.com",
          sessionToken: "session-token",
        },
        {
          fetchImpl,
          readBlob: customReadBlob,
          sleep: async () => {},
        },
      ),
    ).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("Status check failed (HTTP 502)"),
    });

    const jsonParseCapture = mockCaptureException.mock.calls.find(([, context]) => {
      return (
        typeof context === "object" &&
        context !== null &&
        "source" in context &&
        context.source === "share-import-status-response-json-parse"
      );
    });
    expect(jsonParseCapture).toBeUndefined();
  });
});
