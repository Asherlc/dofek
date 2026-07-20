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
}));

vi.mock("@sentry/react", () => ({ captureException: mocks.captureException }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => {
  const initiateResult = { mutateAsync: mocks.initiate };
  const authorizePartsResult = { mutateAsync: mocks.authorizeParts };
  const completeResult = { mutateAsync: mocks.complete };
  const abortResult = { mutateAsync: mocks.abort };
  const trpcUtils = { client: { fileUpload: { resume: { query: mocks.resume } } } };
  return {
    trpc: {
      fileUpload: {
        initiate: { useMutation: () => initiateResult },
        authorizeParts: { useMutation: () => authorizePartsResult },
        complete: { useMutation: () => completeResult },
        abort: { useMutation: () => abortResult },
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

    await act(async () =>
      resolveFirstResume({ upload: { state: "processing", progressPercent: 50 }, parts: [] }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });

    const firstCalls = vi
      .mocked(mocks.resume)
      .mock.calls.filter(([{ uploadId }]) => uploadId === "first");
    expect(firstCalls).toHaveLength(1);
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
});
