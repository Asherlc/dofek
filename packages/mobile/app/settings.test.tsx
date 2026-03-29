// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockFileWrite = vi.fn();
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///tmp/cache" } },
  File: vi.fn().mockImplementation(() => ({
    uri: "file:///tmp/cache/health-export.zip",
    write: mockFileWrite,
  })),
}));

vi.mock("expo-sharing", () => ({
  shareAsync: vi.fn(),
}));

vi.mock("../components/PersonalizationPanel", () => ({
  PersonalizationPanel: () => React.createElement("div", null, "PersonalizationPanel"),
}));

vi.mock("../components/SlackIntegrationPanel", () => ({
  SlackIntegrationPanel: () => React.createElement("div", null, "SlackIntegrationPanel"),
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    logout: vi.fn(),
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

const mockLinkedAccountsRefetch = vi.fn();

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ invalidate: vi.fn() }),
    auth: {
      linkedAccounts: {
        useQuery: () => ({
          isLoading: false,
          data: [
            {
              id: "acct-1",
              authProvider: "ride-with-gps",
              email: "test@example.com",
            },
          ],
          refetch: mockLinkedAccountsRefetch,
        }),
      },
      unlinkAccount: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
    },
    settings: {
      get: {
        useQuery: () => ({ data: { value: "metric" }, refetch: vi.fn() }),
      },
      set: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      deleteAllUserData: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

describe("SettingsScreen linked accounts", () => {
  it("renders friendly provider names instead of raw provider IDs", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Ride with GPS")).toBeTruthy();
    expect(screen.queryByText("ride-with-gps")).toBeNull();
  });
});

describe("SettingsScreen export UI rendering", () => {
  it("renders the Download My Data button", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Download My Data")).toBeTruthy();
  });

  it("shows Exporting... and disables the button while processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    const button = screen.getByText("Download My Data");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Exporting...")).toBeTruthy();
    });

    vi.unstubAllGlobals();
  });
});

describe("SettingsScreen export flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes a successful export: triggers, polls until done, downloads, writes file, and shares", async () => {
    const { shareAsync } = await import("expo-sharing");
    const { File: ExpoFile } = await import("expo-file-system");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://test.example.com/api/export") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jobId: "job-123" }),
        });
      }
      if (url === "https://test.example.com/api/export/status/job-123") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "done",
              progress: 100,
              message: "Ready",
              downloadUrl: "/api/export/download/job-123",
            }),
        });
      }
      if (url === "https://test.example.com/api/export/download/job-123") {
        const fakeBytes = new Uint8Array([1, 2, 3]);
        const blob = new Blob([fakeBytes], { type: "application/zip" });
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(blob),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("Download My Data"));

    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    await waitFor(() => {
      expect(ExpoFile).toHaveBeenCalled();
      expect(mockFileWrite).toHaveBeenCalled();
      expect(shareAsync).toHaveBeenCalledWith(
        "file:///tmp/cache/health-export.zip",
        expect.objectContaining({ mimeType: "application/zip" }),
      );
    });
  });

  it("shows an error state when the trigger request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }),
    );

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("Download My Data"));

    await waitFor(() => {
      expect(screen.getByText("Failed to start export")).toBeTruthy();
    });
  });

  it("shows an error state when the download request fails", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://test.example.com/api/export") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jobId: "job-456" }),
        });
      }
      if (url === "https://test.example.com/api/export/status/job-456") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "done",
              progress: 100,
              downloadUrl: "/api/export/download/job-456",
            }),
        });
      }
      if (url === "https://test.example.com/api/export/download/job-456") {
        return Promise.resolve({ ok: false });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("Download My Data"));

    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText("Failed to download export")).toBeTruthy();
    });
  });
});
