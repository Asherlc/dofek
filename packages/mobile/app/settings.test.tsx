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

vi.mock("expo-updates", () => ({
  updateId: null,
  channel: null,
  runtimeVersion: null,
  createdAt: null,
  isEmbeddedLaunch: true,
}));

vi.mock("../components/PersonalizationPanel", () => ({
  PersonalizationPanel: () => React.createElement("div", null, "PersonalizationPanel"),
}));

vi.mock("../components/SlackIntegrationPanel", () => ({
  SlackIntegrationPanel: () => React.createElement("div", null, "SlackIntegrationPanel"),
}));

vi.mock("../components/ProviderLogo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) =>
    React.createElement("span", { "data-testid": `provider-logo-${provider}` }),
}));

const mockRouterPush = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    logout: vi.fn(),
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

const mockLinkedAccountsRefetch = vi.fn();

const mockProvidersData = [
  { id: "wahoo", name: "Wahoo", authorized: true, importOnly: false },
  { id: "strava", name: "Strava", authorized: true, importOnly: false },
  { id: "polar", name: "Polar", authorized: false, importOnly: false },
];

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ invalidate: vi.fn() }),
    sync: {
      providers: {
        useQuery: () => ({ data: mockProvidersData, isLoading: false }),
      },
    },
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
    bodyAnalytics: {
      setGoalWeight: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      weightPrediction: {
        invalidate: vi.fn(),
      },
    },
  },
}));

describe("SettingsScreen data sources", () => {
  it("renders Data Sources section with connected count", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Data Sources")).toBeTruthy();
    expect(screen.getByText("2 connected")).toBeTruthy();
  });

  it("renders provider logos for connected providers only", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByTestId("provider-logo-wahoo")).toBeTruthy();
    expect(screen.getByTestId("provider-logo-strava")).toBeTruthy();
    expect(screen.queryByTestId("provider-logo-polar")).toBeNull();
  });

  it("navigates to providers screen when tapped", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("2 connected"));

    expect(mockRouterPush).toHaveBeenCalledWith("/providers");
  });
});

describe("SettingsScreen export UI rendering", () => {
  it("renders the Start Export button", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Start Export")).toBeTruthy();
  });

  it("shows Starting... and disables the button while processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    const button = screen.getByText("Start Export");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Starting...")).toBeTruthy();
    });

    vi.unstubAllGlobals();
  });
});

describe("SettingsScreen OTA debug details", () => {
  it("renders OTA created time in the local timezone format", async () => {
    const updatesModule = await import("expo-updates");
    const otaCreatedAt = new Date("2026-03-31T18:22:00.000Z");
    updatesModule.createdAt = otaCreatedAt;

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    const expectedLocalTimestamp = otaCreatedAt.toLocaleString();
    expect(
      screen.getByText((content) => content.includes(`Created: ${expectedLocalTimestamp}`)),
    ).toBeTruthy();

    updatesModule.createdAt = null;
  });
});

describe("SettingsScreen export flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows active exports and tells the user to expect email", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://test.example.com/api/export") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              exports: [
                {
                  id: "export-123",
                  status: "processing",
                  filename: "dofek-export.zip",
                  sizeBytes: null,
                  createdAt: "2026-04-26T12:00:00.000Z",
                  startedAt: "2026-04-26T12:01:00.000Z",
                  completedAt: null,
                  expiresAt: "2026-05-03T12:00:00.000Z",
                  errorMessage: null,
                },
              ],
            }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await waitFor(() => {
      expect(screen.getByText("Export in progress")).toBeTruthy();
    });
    expect(screen.getByText("We'll email you when it finishes.")).toBeTruthy();
  });

  it("queues an export and refreshes the export list", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exports: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "queued", exportId: "export-456" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            exports: [
              {
                id: "export-456",
                status: "queued",
                filename: "dofek-export.zip",
                sizeBytes: null,
                createdAt: "2026-04-26T12:00:00.000Z",
                startedAt: null,
                completedAt: null,
                expiresAt: "2026-05-03T12:00:00.000Z",
                errorMessage: null,
              },
            ],
          }),
      });

    vi.stubGlobal("fetch", mockFetch);

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("No exports available.");
    fireEvent.click(screen.getByText("Start Export"));

    await waitFor(() => {
      expect(screen.getByText("Export in progress")).toBeTruthy();
    });
  });

  it("shows an error state when the trigger request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ exports: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({}),
        }),
    );

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("No exports available.");
    fireEvent.click(screen.getByText("Start Export"));

    await waitFor(() => {
      expect(screen.getByText("Failed to start export")).toBeTruthy();
    });
  });

  it("downloads a completed export from the available export list", async () => {
    const { shareAsync } = await import("expo-sharing");
    const { File: ExpoFile } = await import("expo-file-system");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://test.example.com/api/export") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              exports: [
                {
                  id: "export-789",
                  status: "completed",
                  filename: "dofek-export.zip",
                  sizeBytes: 1024,
                  createdAt: "2026-04-25T12:00:00.000Z",
                  startedAt: "2026-04-25T12:01:00.000Z",
                  completedAt: "2026-04-25T12:02:00.000Z",
                  expiresAt: "2026-05-02T12:02:00.000Z",
                  errorMessage: null,
                },
              ],
            }),
        });
      }
      if (url === "https://test.example.com/api/export/download/export-789") {
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

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("Available exports");
    fireEvent.click(screen.getByText("Download dofek-export.zip"));

    await waitFor(() => {
      expect(ExpoFile).toHaveBeenCalled();
      expect(mockFileWrite).toHaveBeenCalled();
      expect(shareAsync).toHaveBeenCalledWith(
        "file:///tmp/cache/health-export.zip",
        expect.objectContaining({ mimeType: "application/zip" }),
      );
    });
  });
});
