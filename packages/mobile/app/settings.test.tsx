// @vitest-environment jsdom

import { formatDateTime } from "@dofek/format/format";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFileWrite = vi.fn();
const mockDownloadFileAsync = vi.fn();
vi.mock("expo-file-system", () => {
  const MockFile = vi.fn().mockImplementation((_cache, filename: string) => ({
    uri: `file:///tmp/cache/${filename}`,
    write: mockFileWrite,
  }));
  MockFile.downloadFileAsync = mockDownloadFileAsync;
  return {
    Paths: { cache: { uri: "file:///tmp/cache" } },
    File: MockFile,
  };
});

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
const mockLogout = vi.fn();
const mockCheckoutSession = vi.fn();
const mockPortalSession = vi.fn();
let mockSessionToken: string | null = "test-token";
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
    logout: mockLogout,
    serverUrl: "https://test.example.com",
    sessionToken: mockSessionToken,
  }),
}));

const mockLinkedAccountsRefetch = vi.fn();
const mockCaptureException = vi.fn();
const mockSettingsGetData = vi.fn();
const mockSettingsSetData = vi.fn();
const mockSettingsInvalidate = vi.fn();
const mockSettingsSetMutate = vi.fn();
const mockUnitSettingRefetch = vi.fn();
const mockUnitSettingQuery: {
  data: { key: string; value: unknown } | undefined;
  error: Error | null;
  refetch: typeof mockUnitSettingRefetch;
} = {
  data: { key: "unitSystem", value: "metric" },
  error: null,
  refetch: mockUnitSettingRefetch,
};
const mockZeppPairingClaim = vi.fn();
type ZeppPairingMutationOptions = {
  onError?: (error: { message: string }) => void;
  onMutate?: () => void;
  onSuccess?: () => void;
};
let mockZeppPairingMutationOptions: ZeppPairingMutationOptions | null = null;
type SetPasswordMutationOptions = {
  onError?: (error: { message: string }) => void;
  onSuccess?: () => Promise<void>;
};
let mockSetPasswordMutationOptions: SetPasswordMutationOptions | null = null;
const mockPasswordCredentialStatusQuery = vi.fn(() => ({
  data: { hasPassword: false },
  isLoading: false,
  error: null,
}));

const mockProvidersData = [
  { id: "wahoo", name: "Wahoo", authorized: true, importOnly: false },
  { id: "strava", name: "Strava", authorized: true, importOnly: false },
  { id: "polar", name: "Polar", authorized: false, importOnly: false },
];
const mockProvidersQuery: {
  data: typeof mockProvidersData | undefined;
  error: Error | null;
  isLoading: boolean;
} = {
  data: mockProvidersData,
  error: null,
  isLoading: false,
};

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      invalidate: vi.fn(),
      auth: { passwordCredentialStatus: { invalidate: vi.fn() } },
      bodyAnalytics: { weightPrediction: { invalidate: vi.fn() } },
      settings: {
        get: {
          getData: mockSettingsGetData,
          setData: mockSettingsSetData,
          invalidate: mockSettingsInvalidate,
        },
      },
    }),
    sync: {
      providers: {
        useQuery: () => mockProvidersQuery,
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
      passwordCredentialStatus: {
        useQuery: () => mockPasswordCredentialStatusQuery(),
      },
      setPassword: {
        useMutation: (options: SetPasswordMutationOptions) => {
          mockSetPasswordMutationOptions = options;
          return {
            mutate: vi.fn(),
            isPending: false,
          };
        },
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
    companionPairing: {
      claim: {
        useMutation: (options: ZeppPairingMutationOptions) => {
          mockZeppPairingMutationOptions = options;
          return {
            mutate: (input: { code: string }) => {
              options.onMutate?.();
              mockZeppPairingClaim(input);
            },
            isPending: false,
            isError: false,
            error: null,
          };
        },
      },
    },
    medicationDoseEvents: {
      list: {
        useQuery: () => ({ data: { events: [] }, isLoading: false, error: null }),
      },
    },
    settings: {
      get: {
        useQuery: (input: { key: string }) =>
          input.key === "unitSystem"
            ? mockUnitSettingQuery
            : { data: { value: "metric" }, error: null, refetch: vi.fn() },
      },
      set: {
        useMutation: () => ({ mutate: mockSettingsSetMutate, isPending: false }),
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

vi.mock("../lib/telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

beforeEach(() => {
  mockProvidersQuery.data = mockProvidersData;
  mockProvidersQuery.error = null;
  mockProvidersQuery.isLoading = false;
  mockSessionToken = "test-token";
  mockBillingStatus = {
    ...defaultBillingStatus,
    access: { ...defaultBillingStatus.access },
  };
  mockZeppPairingMutationOptions = null;
  mockSetPasswordMutationOptions = null;
  mockUnitSettingQuery.data = { key: "unitSystem", value: "metric" };
  mockUnitSettingQuery.error = null;
  vi.clearAllMocks();
});

describe("SettingsScreen unit system", () => {
  it("restores the exact cached unit setting and shows the server error when a write fails", async () => {
    const previousSetting = { key: "unitSystem", value: "metric" };
    mockSettingsGetData.mockReturnValue(previousSetting);
    const { default: SettingsScreen } = await import("./settings");
    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Imperial" }));
    const options = mockSettingsSetMutate.mock.calls[0]?.[1];
    const writeError = new Error("Unit preference was not saved.");
    act(() => options.onError(writeError));
    act(() => options.onSettled());

    expect(mockSettingsSetData).toHaveBeenLastCalledWith({ key: "unitSystem" }, previousSetting);
    expect(mockSettingsInvalidate).toHaveBeenCalledWith({ key: "unitSystem" });
    expect(Alert.alert).toHaveBeenCalledWith("Error", writeError.message);
    expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
      context: "unit-system-write",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("keeps cached units visible and displays an exact background read error", async () => {
    const readError = new Error("Unit settings could not be loaded.");
    mockUnitSettingQuery.error = readError;
    const { default: SettingsScreen } = await import("./settings");
    render(<SettingsScreen />);

    expect(screen.getByRole("button", { name: "Metric" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText(readError.message)).toBeTruthy();
    await waitFor(() =>
      expect(mockCaptureException).toHaveBeenCalledWith(readError, {
        context: "unit-system-read",
      }),
    );
    expect(mockCaptureException.mock.calls.filter(([error]) => error === readError)).toHaveLength(
      1,
    );
  });
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

  it("shows the provider inventory error instead of a zero count on initial failure", async () => {
    mockProvidersQuery.data = undefined;
    mockProvidersQuery.error = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );

    const { default: SettingsScreen } = await import("./settings");
    render(<SettingsScreen />);

    expect(
      screen.getByText("Analytics data is temporarily unavailable. Please retry in a minute."),
    ).toBeTruthy();
    expect(screen.queryByText("0 connected")).toBeNull();
  });

  it("shows retained provider inventory with a refresh warning after a background failure", async () => {
    mockProvidersQuery.error = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );

    const { default: SettingsScreen } = await import("./settings");
    render(<SettingsScreen />);

    expect(screen.getByText("2 connected")).toBeTruthy();
    expect(screen.getByText("Could not refresh data sources")).toBeTruthy();
    expect(
      screen.getByText("Analytics data is temporarily unavailable. Please retry in a minute."),
    ).toBeTruthy();
  });

  it("exposes the Data Sources card as a named accessibility action", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    const dataSourcesButton = screen.getByRole("button", { name: "Data Sources" });
    expect(dataSourcesButton.getAttribute("aria-label")).toBe("Data Sources");
  });

  it("uses layman-readable names for Bluetooth and motion developer tools", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByRole("button", { name: "Bluetooth Low Energy probe" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Inertial measurement unit visualization" }),
    ).toBeTruthy();
  });

  it("navigates to providers screen when tapped", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("2 connected"));

    expect(mockRouterPush).toHaveBeenCalledWith("/providers");
  });

  it("navigates to cycle tracking from the health tracking section", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Cycle Tracking" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/cycle");
  });
});

describe("SettingsScreen reports", () => {
  it("opens the health reports screen", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Health Reports" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/reports");
  });
});

describe("SettingsScreen password", () => {
  it("renders set password controls when no password credential exists", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: false },
      isLoading: false,
      error: null,
    });

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(await screen.findByText("Password")).toBeTruthy();
    expect(await screen.findByText("Set Password")).toBeTruthy();
  });

  it("renders change password controls when a password credential exists", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(await screen.findByPlaceholderText("Current password")).toBeTruthy();
    expect(await screen.findByText("Change Password")).toBeTruthy();
  });

  it("confirms before logging out after changing an existing password", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);
    await act(async () => {
      await mockSetPasswordMutationOptions?.onSuccess?.();
    });

    expect(mockLogout).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("Password Updated", "Please sign in again.", [
      { text: "OK", onPress: expect.any(Function) },
    ]);

    const onPress = alertSpy.mock.calls[0]?.[2]?.[0]?.onPress;
    onPress?.();

    expect(mockLogout).toHaveBeenCalledOnce();
  });
});

describe("SettingsScreen Zepp pairing", () => {
  it("claims a short code from settings", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    fireEvent.change(screen.getByPlaceholderText("Short code"), {
      target: { value: "ABCD23" },
    });
    fireEvent.click(screen.getByText("Connect Zepp App"));

    expect(mockZeppPairingClaim).toHaveBeenCalledWith({ code: "ABCD23" });
  });

  it("clears stale pairing messages when the code changes", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);
    await act(async () => {
      mockZeppPairingMutationOptions?.onError?.({ message: "Old pairing error" });
    });
    expect(await screen.findByText("Old pairing error")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Short code"), {
      target: { value: "WXYZ34" },
    });

    expect(screen.queryByText("Old pairing error")).toBeNull();
  });
});

describe("SettingsScreen medication doses", () => {
  it("shows medication dose empty state when no imported dose events exist", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Medication Doses")).toBeTruthy();
    expect(screen.getByText("Review imported medication dose events")).toBeTruthy();
    expect(screen.getByText("No medication dose events yet.")).toBeTruthy();
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
  it("renders the Start Export button", async () => {
    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Start Export")).toBeTruthy();
  });

  it("shows Starting... and disables the button while processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ exports: [] }),
        })
        .mockImplementation(() => new Promise(() => {})),
    );

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("No exports available.");
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

    const expectedLocalTimestamp = formatDateTime(otaCreatedAt);
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

  it("does not request exports when the session token is blank", async () => {
    mockSessionToken = "   ";
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("Sign in again to load exports.");
    expect(mockFetch).not.toHaveBeenCalled();
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
    mockDownloadFileAsync.mockResolvedValue(undefined);

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
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);

    const { default: SettingsScreen } = await import("./settings");

    render(<SettingsScreen />);

    await screen.findByText("Available exports");
    fireEvent.click(screen.getByText("Download dofek-export.zip"));

    await waitFor(() => {
      expect(ExpoFile).toHaveBeenCalled();
      expect(mockDownloadFileAsync).toHaveBeenCalledWith(
        "https://test.example.com/api/export/download/export-789",
        expect.objectContaining({ uri: "file:///tmp/cache/export-789-dofek-export.zip" }),
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
          idempotent: true,
        }),
      );
      expect(shareAsync).toHaveBeenCalledWith(
        "file:///tmp/cache/export-789-dofek-export.zip",
        expect.objectContaining({ mimeType: "application/zip" }),
      );
    });
  });
});
