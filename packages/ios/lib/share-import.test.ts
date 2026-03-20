import { describe, expect, it, vi } from "vitest";
import {
  inferImportProviderFromFile,
  importSharedFile,
  type ImportProviderId,
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
    const fetchImpl = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
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
    const uploadCall = fetchImpl.mock.calls[1] as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(uploadCall?.[0]).toBe("https://example.com/api/upload/strong-csv?units=kg");
    const uploadHeaders = uploadCall?.[1]?.headers as Record<string, string>;
    expect(uploadHeaders.Authorization).toBe("Bearer session-token");
  });

  it("throws for unsupported file extension", async () => {
    const fetchImpl = vi.fn() as ReturnType<typeof vi.fn> & typeof fetch;
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
