// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataExportSection } from "./DataExportSection";

vi.mock("expo-file-system", () => ({
  File: class {},
  Paths: { cache: {} },
}));

vi.mock("expo-sharing", () => ({
  shareAsync: vi.fn(),
}));

describe("DataExportSection", () => {
  beforeEach(() => {
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
