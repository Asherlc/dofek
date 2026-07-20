// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  authorizeParts: vi.fn(),
  complete: vi.fn(),
  initiate: vi.fn(),
  resume: vi.fn(),
  runUpload: vi.fn(),
  sessionGet: vi.fn(async (): Promise<unknown> => null),
  sessionDelete: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    fileUpload: {
      initiate: { useMutation: () => ({ mutateAsync: mocks.initiate }) },
      authorizeParts: { useMutation: () => ({ mutateAsync: mocks.authorizeParts }) },
      complete: { useMutation: () => ({ mutateAsync: mocks.complete }) },
      abort: { useMutation: () => ({ mutateAsync: mocks.abort }) },
    },
    useUtils: () => ({ client: { fileUpload: { resume: { query: mocks.resume } } } }),
  },
}));

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
});
