import { describe, expect, it, vi } from "vitest";
import {
  type ImportProviderId,
  importSharedFile,
  inferImportProviderFromFile,
} from "./share-import";

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
});

describe("importSharedFile", () => {
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
        headers: expect.objectContaining({ Authorization: "Bearer session-token" }),
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
});
