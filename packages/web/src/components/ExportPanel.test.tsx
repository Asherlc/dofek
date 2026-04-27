/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel.tsx";

const activeExport = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "processing",
  filename: "dofek-export.zip",
  sizeBytes: null,
  createdAt: "2026-04-26T12:00:00.000Z",
  startedAt: "2026-04-26T12:01:00.000Z",
  completedAt: null,
  expiresAt: "2026-05-03T12:00:00.000Z",
  errorMessage: null,
};

const completedExport = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "completed",
  filename: "dofek-export.zip",
  sizeBytes: 2048,
  createdAt: "2026-04-25T12:00:00.000Z",
  startedAt: "2026-04-25T12:01:00.000Z",
  completedAt: "2026-04-25T12:02:00.000Z",
  expiresAt: "2026-05-02T12:02:00.000Z",
  errorMessage: null,
};

describe("ExportPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows active exports, email expectation, and completed export downloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ exports: [activeExport, completedExport] }),
      }),
    );

    render(<ExportPanel />);

    expect(await screen.findByText("Export in progress")).toBeTruthy();
    expect(screen.getByText("We'll email you when it finishes.")).toBeTruthy();
    expect(screen.getByText("Available exports")).toBeTruthy();

    const downloadLink = screen.getByRole("link", { name: "Download dofek-export.zip" });
    expect(downloadLink.getAttribute("href")).toBe(`/api/export/download/${completedExport.id}`);
  });

  it("queues an offline export and refreshes the export list", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exports: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "queued", exportId: activeExport.id }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exports: [activeExport] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    render(<ExportPanel />);

    await screen.findByText("No exports available.");
    fireEvent.click(screen.getByRole("button", { name: "Start Export" }));

    await waitFor(() => {
      expect(screen.getByText("Export in progress")).toBeTruthy();
    });
    expect(screen.getByText("We'll email you when it finishes.")).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith("/api/export", {
      method: "POST",
      credentials: "include",
    });
  });
});
