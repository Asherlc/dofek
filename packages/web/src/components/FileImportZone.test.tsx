// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  authorizeParts: vi.fn(),
  complete: vi.fn(),
  initiate: vi.fn(),
  resume: vi.fn(),
  runUpload: vi.fn(),
  captureException: vi.fn(),
  sessionGet: vi.fn(async (): Promise<unknown> => null),
  sessionDelete: vi.fn(),
  invalidateAvailableDataTypes: vi.fn(),
  invalidateLogs: vi.fn(),
  invalidateProviderStats: vi.fn(),
  invalidateRecords: vi.fn(),
  freshMutationResults: false,
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => {
  const initiateResult = { mutateAsync: mocks.initiate };
  const authorizePartsResult = { mutateAsync: mocks.authorizeParts };
  const completeResult = { mutateAsync: mocks.complete };
  const abortResult = { mutateAsync: mocks.abort };
  const trpcUtils = {
    client: { fileUpload: { resume: { query: mocks.resume } } },
    providerDetail: {
      availableDataTypes: { invalidate: mocks.invalidateAvailableDataTypes },
      logs: { invalidate: mocks.invalidateLogs },
      records: { invalidate: mocks.invalidateRecords },
    },
    sync: { providerStats: { invalidate: mocks.invalidateProviderStats } },
  };
  return {
    trpc: {
      fileUpload: {
        initiate: {
          useMutation: () =>
            mocks.freshMutationResults ? { mutateAsync: mocks.initiate } : initiateResult,
        },
        authorizeParts: {
          useMutation: () =>
            mocks.freshMutationResults
              ? { mutateAsync: mocks.authorizeParts }
              : authorizePartsResult,
        },
        complete: {
          useMutation: () =>
            mocks.freshMutationResults ? { mutateAsync: mocks.complete } : completeResult,
        },
        abort: {
          useMutation: () =>
            mocks.freshMutationResults ? { mutateAsync: mocks.abort } : abortResult,
        },
      },
      useUtils: () => trpcUtils,
    },
  };
});

vi.mock("../lib/resumable-file-upload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/resumable-file-upload.ts")>();
  return {
    ...actual,
    runResumableFileUpload: mocks.runUpload,
    indexedDbUploadSessionStore: {
      get: mocks.sessionGet,
      put: vi.fn(),
      delete: mocks.sessionDelete,
    },
  };
});

const { FileImportZone } = await import("./FileImportZone.tsx");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.sessionGet.mockResolvedValue(null);
  mocks.freshMutationResults = false;
});

describe("FileImportZone", () => {
  it("renders an explicit file picker", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        importType="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
      />,
    );

    expect(screen.getByRole("button", { name: "Import file" })).toBeTruthy();
    expect(screen.getByText(".csv export from Strong app")).toBeTruthy();
  });

  it("starts the resumable upload protocol for a dropped file", async () => {
    mocks.runUpload.mockImplementation(async ({ onProgress }) => {
      onProgress({ phase: "uploading", percentage: 42, message: "Uploaded 1 of 3 parts" });
      return {
        uploadId: "00000000-0000-4000-8000-0000000000f7",
        state: "queued",
        partSizeBytes: 16 * 1024 * 1024,
        importJobId: "file-import-00000000-0000-4000-8000-0000000000f7",
      };
    });
    mocks.resume.mockResolvedValue({
      upload: { state: "completed", progressPercent: 100 },
      parts: [],
    });
    render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
      />,
    );

    fireEvent.drop(screen.getByRole("region", { name: "Garmin file drop zone" }), {
      dataTransfer: { files: [new File(["zip-data"], "garmin.zip", { type: "application/zip" })] },
    });

    await waitFor(() => expect(mocks.runUpload).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText("Import completed")).toBeTruthy());
    expect(mocks.invalidateAvailableDataTypes).toHaveBeenCalledWith({
      providerId: "garmin-dump",
    });
    expect(mocks.invalidateLogs).toHaveBeenCalledWith({ providerId: "garmin-dump" });
    expect(mocks.invalidateProviderStats).toHaveBeenCalledOnce();
    expect(mocks.invalidateRecords).toHaveBeenCalledOnce();
  });

  it("keeps an upload active across mutation-result rerenders", async () => {
    mocks.freshMutationResults = true;
    let uploadSignal: AbortSignal | undefined;
    mocks.runUpload.mockImplementation(
      async ({
        onProgress,
        signal,
      }: {
        onProgress: (progress: { phase: "uploading"; percentage: number; message: string }) => void;
        signal: AbortSignal;
      }) => {
        uploadSignal = signal;
        onProgress({ phase: "uploading", percentage: 25, message: "Uploading Kaya export..." });
        await new Promise(() => undefined);
        throw new Error("unreachable");
      },
    );

    render(
      <FileImportZone
        providerId="kaya-export"
        importType="kaya-export"
        title="Kaya"
        description=".csv export from Kaya"
        accept=".csv"
      />,
    );

    fireEvent.drop(screen.getByRole("region", { name: "Kaya file drop zone" }), {
      dataTransfer: {
        files: [new File(["kaya-data"], "kaya-export.csv", { type: "text/csv" })],
      },
    });

    await waitFor(() => expect(screen.getByText("Uploading Kaya export...")).toBeTruthy());
    expect(uploadSignal?.aborted).toBe(false);
  });

  it("prompts for the same file when resumable metadata exists", async () => {
    mocks.sessionGet.mockResolvedValue({ uploadId: "saved-upload" });
    render(
      <FileImportZone
        providerId="fit-file"
        importType="fit-file"
        title="FIT File"
        description=".fit file"
        accept=".fit"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Select the same file to resume upload")).toBeTruthy(),
    );
  });

  it("reports IndexedDB session lookup failures", async () => {
    mocks.sessionGet.mockRejectedValue(new Error("Upload session storage is unavailable"));

    render(
      <FileImportZone
        providerId="fit-file"
        importType="fit-file"
        title="FIT File"
        description=".fit file"
        accept=".fit"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Upload session storage is unavailable")).toBeTruthy(),
    );
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { uploadId: "pending" },
    });
  });

  it("ignores IndexedDB session lookup failures after unmount", async () => {
    let rejectSessionLookup: (error: Error) => void = () => undefined;
    mocks.sessionGet.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSessionLookup = reject;
      }),
    );
    const rendered = render(
      <FileImportZone
        providerId="fit-file"
        importType="fit-file"
        title="FIT File"
        description=".fit file"
        accept=".fit"
      />,
    );

    rendered.unmount();
    await act(async () => rejectSessionLookup(new Error("late session lookup failure")));

    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports active upload polling failures", async () => {
    mocks.resume.mockRejectedValue(new Error("Upload status is unavailable"));

    render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{
          jobId: "file-import-00000000-0000-4000-8000-0000000000f7",
          status: "running",
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Upload status is unavailable")).toBeTruthy());
    expect(mocks.resume).toHaveBeenCalledWith({
      uploadId: "00000000-0000-4000-8000-0000000000f7",
    });
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { uploadId: "00000000-0000-4000-8000-0000000000f7" },
    });
  });

  it("ignores polling failures after unmount", async () => {
    let rejectResume: (error: Error) => void = () => undefined;
    mocks.resume.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectResume = reject;
      }),
    );
    const rendered = render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{
          jobId: "file-import-00000000-0000-4000-8000-0000000000f7",
          status: "running",
        }}
      />,
    );
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());

    rendered.unmount();
    await act(async () => rejectResume(new Error("late polling failure")));

    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("stops the previous polling loop when the active import changes", async () => {
    let resolveFirstResume: (value: {
      upload: { state: string; progressPercent: number };
      parts: unknown[];
    }) => void = () => undefined;
    mocks.resume.mockImplementation(({ uploadId }) => {
      if (uploadId === "first") {
        return new Promise((resolve) => {
          resolveFirstResume = resolve;
        });
      }
      return Promise.resolve({ upload: { state: "completed", progressPercent: 100 }, parts: [] });
    });

    const props = (jobId: string) => ({
      providerId: "garmin-dump",
      importType: "garmin-dump" as const,
      title: "Garmin",
      description: ".zip account export",
      accept: ".zip",
      activeImport: { jobId, status: "running" as const },
    });

    const { rerender } = render(<FileImportZone {...props("file-import-first")} />);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ uploadId: "first" }));

    rerender(<FileImportZone {...props("file-import-second")} />);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ uploadId: "second" }));

    vi.useFakeTimers();
    try {
      await act(async () =>
        resolveFirstResume({ upload: { state: "processing", progressPercent: 50 }, parts: [] }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(1_000));

      const firstCalls = vi
        .mocked(mocks.resume)
        .mock.calls.filter(([{ uploadId }]) => uploadId === "first");
      expect(firstCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up local state when server cancellation fails", async () => {
    mocks.resume.mockResolvedValue({
      upload: { state: "queued", progressPercent: 20 },
      parts: [],
    });
    mocks.abort.mockRejectedValue(new Error("Server cancellation is unavailable"));

    render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{
          jobId: "file-import-00000000-0000-4000-8000-0000000000f7",
          status: "running",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mocks.sessionDelete).toHaveBeenCalledWith("garmin-dump"));
    expect(mocks.abort).toHaveBeenCalledWith({
      uploadId: "00000000-0000-4000-8000-0000000000f7",
    });
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { uploadId: "00000000-0000-4000-8000-0000000000f7" },
    });
    await waitFor(() =>
      expect(
        screen.getByText("Upload cancelled locally. Server cancellation is unavailable"),
      ).toBeTruthy(),
    );
  });

  it("cancels an in-flight local upload before it has a server upload ID", async () => {
    mocks.runUpload.mockImplementation(
      async ({
        onProgress,
        signal,
      }: {
        onProgress: (progress: unknown) => void;
        signal: AbortSignal;
      }) => {
        onProgress({ phase: "uploading", percentage: 10, message: "Uploading..." });
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Upload cancelled", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
      />,
    );
    fireEvent.drop(screen.getByRole("region", { name: "Garmin file drop zone" }), {
      dataTransfer: { files: [new File(["zip-data"], "garmin.zip")] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Upload cancelled")).toBeTruthy());
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.sessionDelete).not.toHaveBeenCalled();
  });

  it("renders an import without a provider link and accepts drag state changes", () => {
    render(
      <FileImportZone
        importType="fit-file"
        title="FIT File"
        description="A local FIT activity export"
        accept=".fit"
        showDetailsLink={false}
        recentLogs={[
          {
            status: "success",
            syncedAt: "2026-01-01T00:00:00.000Z",
            recordCount: 1,
            durationMs: 10,
          },
          {
            status: "error",
            syncedAt: "2026-01-02T00:00:00.000Z",
            recordCount: 0,
            durationMs: 10,
          },
        ]}
      />,
    );

    const dropZone = screen.getByRole("region", { name: "FIT File file drop zone" });
    fireEvent.dragOver(dropZone);
    expect(dropZone.className).toContain("border-blue-500");
    fireEvent.dragLeave(dropZone);
    expect(dropZone.className).toContain("border-border-strong");
    fireEvent.drop(dropZone, { dataTransfer: { files: [] } });

    expect(screen.queryByRole("link", { name: "Details" })).toBeNull();
  });

  it("reports terminal upload failures and expiry messages", async () => {
    mocks.resume.mockResolvedValueOnce({
      upload: { state: "failed", progressPercent: 40, errorMessage: null },
      parts: [],
    });
    const { rerender } = render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{ jobId: "file-import-failed", status: "running" }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Import failed")).toBeTruthy());

    mocks.resume.mockResolvedValueOnce({
      upload: { state: "expired", progressPercent: 20 },
      parts: [],
    });
    rerender(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{ jobId: "file-import-expired", status: "running" }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Upload expired")).toBeTruthy());
  });

  it("surfaces failed local cleanup after cancelling a server upload", async () => {
    mocks.resume.mockResolvedValue({
      upload: { state: "queued", progressPercent: 20 },
      parts: [],
    });
    mocks.sessionDelete.mockRejectedValue(new Error("Local upload cleanup failed"));

    render(
      <FileImportZone
        providerId="garmin-dump"
        importType="garmin-dump"
        title="Garmin"
        description=".zip account export"
        accept=".zip"
        activeImport={{
          jobId: "file-import-00000000-0000-4000-8000-0000000000f7",
          status: "running",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Local upload cleanup failed")).toBeTruthy());
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { uploadId: "00000000-0000-4000-8000-0000000000f7" },
    });
  });
});
