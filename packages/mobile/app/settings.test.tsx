// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const mockCheckoutSession = vi.fn();
const mockPortalSession = vi.fn();
const defaultBillingStatus = {
  hasFullAccess: false,
  access: {
    kind: "limited",
    paid: false,
    reason: "free_signup_week",
    startDate: "2026-04-01",
    endDateExclusive: "2026-04-08",
  } as const,
  stripeSubscriptionStatus: null,
  canManageBilling: false,
};
let mockBillingStatus = {
  ...defaultBillingStatus,
  access: { ...defaultBillingStatus.access },
};

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
      set: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    billing: {
      status: { useQuery: () => ({ data: mockBillingStatus, isLoading: false }) },
      createCheckoutSession: {
        useMutation: () => ({
          mutate: mockCheckoutSession,
          isPending: false,
        }),
      },
      createPortalSession: {
        useMutation: () => ({
          mutate: mockPortalSession,
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

beforeEach(() => {
  mockBillingStatus = {
    ...defaultBillingStatus,
    access: { ...defaultBillingStatus.access },
  };
  vi.clearAllMocks();
});

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

describe("SettingsScreen billing", () => {
  it("renders signup-week limited access notice", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.getByText(/Access limited to your signup week/)).toBeTruthy();
    expect(screen.getByText("Upgrade to Full Access")).toBeTruthy();
  });

  it("starts checkout when the upgrade button is pressed", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("Upgrade to Full Access"));

    expect(mockCheckoutSession).toHaveBeenCalled();
  });

  it("shows manage billing when billing is managed by Stripe", async () => {
    mockBillingStatus = {
      hasFullAccess: true,
      access: {
        kind: "full",
        paid: true,
        reason: "stripe_subscription",
      },
      stripeSubscriptionStatus: "active",
      canManageBilling: true,
    };

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Manage Billing")).toBeTruthy();
    fireEvent.click(screen.getByText("Manage Billing"));

    expect(mockPortalSession).toHaveBeenCalled();
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
