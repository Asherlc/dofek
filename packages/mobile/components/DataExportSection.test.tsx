// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

import { DataExportSection } from "./DataExportSection";

const fileSystemMocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  downloadFileAsync: vi.fn(),
}));
const sharingMocks = vi.hoisted(() => ({
  shareAsync: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    readonly uri = "file:///cache/dofek-exports-v1";
    create = vi.fn();
  },
  File: class {
    static downloadFileAsync = fileSystemMocks.downloadFileAsync;
    readonly exists = true;
    readonly uri: string;
    delete = fileSystemMocks.deleteFile;

    constructor(_directory: unknown, filename: string) {
      this.uri = `file:///cache/dofek-exports-v1/${filename}`;
    }
  },
  Paths: { cache: { uri: "file:///cache" } },
}));

vi.mock("expo-sharing", () => sharingMocks);

function emptyExportListResponse() {
  return {
    ok: true,
    json: async () => ({ exports: [] }),
  };
}

describe("DataExportSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMocks.downloadFileAsync.mockResolvedValue(undefined);
    sharingMocks.shareAsync.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          exports: [
            {
              completedAt: null,
              createdAt: "2026-07-23T00:00:00.000Z",
              errorMessage: null,
              expiresAt: "2026-07-30T00:00:00.000Z",
              filename: "health-export.zip",
              id: "export-1",
              sizeBytes: null,
              startedAt: "2026-07-23T00:01:00.000Z",
              status: "processing",
            },
          ],
        }),
      }),
    );
  });

  it("announces that an active export is in progress", async () => {
    render(<DataExportSection serverUrl="https://dofek.test" sessionToken="session-token" />);

    const exportButton = await screen.findByRole("button", { name: "Export in progress" });
    expect(exportButton.getAttribute("aria-busy")).toBe("true");
    expect(exportButton).toHaveProperty("disabled", true);
  });

  it("deletes a downloaded health export after the share sheet closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          exports: [
            {
              completedAt: "2026-07-23T00:02:00.000Z",
              createdAt: "2026-07-23T00:00:00.000Z",
              errorMessage: null,
              expiresAt: "2026-07-30T00:00:00.000Z",
              filename: "health-export.zip",
              id: "export-1",
              sizeBytes: 1024,
              startedAt: "2026-07-23T00:01:00.000Z",
              status: "completed",
            },
          ],
        }),
      }),
    );
    render(<DataExportSection serverUrl="https://dofek.test" sessionToken="session-token" />);

    const downloadButton = await screen.findByRole("button", {
      name: "Download health-export.zip",
    });
    await act(async () => {
      fireEvent.click(downloadButton);
    });

    await vi.waitFor(() => {
      expect(sharingMocks.shareAsync).toHaveBeenCalledWith(
        "file:///cache/dofek-exports-v1/export-1-health-export.zip",
        expect.objectContaining({ mimeType: "application/zip" }),
      );
      expect(fileSystemMocks.deleteFile).toHaveBeenCalledOnce();
    });
  });

  it("does not update state when the export list resolves after unmount", async () => {
    type ExportListResponse = {
      ok: true;
      json: () => Promise<{ exports: [] }>;
    };
    let resolveFetch: (response: ExportListResponse) => void = () => undefined;
    const pendingFetch = new Promise<ExportListResponse>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch));

    const rendered = render(
      <DataExportSection serverUrl="https://dofek.test" sessionToken="session-token" />,
    );
    expect(fetch).toHaveBeenCalledOnce();

    rendered.unmount();
    const existingWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    try {
      resolveFetch({
        ok: true,
        json: async () => ({ exports: [] }),
      });
      await pendingFetch;
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.stubGlobal("window", existingWindow);
    }
  });

  it("captures a typed HTTP 5xx when starting an export fails", async () => {
    const serverMessage =
      "Export request was saved, but the queue is temporarily unavailable. It will retry automatically.";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(emptyExportListResponse())
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({ error: serverMessage }),
        }),
    );

    render(<DataExportSection serverUrl="https://dofek.test" sessionToken="session-token" />);
    await screen.findByText("No exports available.");
    mockCaptureException.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Export" }));
    });

    expect(await screen.findByText(serverMessage)).toBeTruthy();
    const { HttpResponseError, classifyHandledFailure } = await import(
      "@dofek/telemetry/handled-failure"
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(HttpResponseError),
      expect.objectContaining({ context: "data-export-start" }),
    );
    const captured = mockCaptureException.mock.calls[0]?.[0];
    expect(captured).toMatchObject({ message: serverMessage, status: 503 });
    expect(classifyHandledFailure(captured)).toBe("http_5xx");
  });

  it("shows a non-5xx export start failure without counting it as http_5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(emptyExportListResponse())
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: "Export already in progress" }),
        }),
    );

    render(<DataExportSection serverUrl="https://dofek.test" sessionToken="session-token" />);
    await screen.findByText("No exports available.");
    mockCaptureException.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Export" }));
    });

    expect(await screen.findByText("Export already in progress")).toBeTruthy();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
