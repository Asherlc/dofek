// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
