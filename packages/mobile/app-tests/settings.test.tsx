// @vitest-environment jsdom

import { formatDateTime } from "@dofek/format/format";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFileWrite = vi.fn();
const mockFileDelete = vi.fn();
const mockDownloadFileAsync = vi.fn();
vi.mock("expo-file-system", () => {
  const MockDirectory = vi
    .fn()
    .mockImplementation((parent: { uri: string }, directoryName: string) => ({
      create: vi.fn(),
      delete: vi.fn(),
      exists: true,
      uri: `${parent.uri}/${directoryName}`,
    }));
  const MockFile = vi.fn().mockImplementation((parent: { uri: string }, filename: string) => ({
    delete: mockFileDelete,
    exists: true,
    uri: `${parent.uri}/${filename}`,
    write: mockFileWrite,
  }));
  MockFile.downloadFileAsync = mockDownloadFileAsync;
  return {
    Directory: MockDirectory,
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

vi.mock("../lib/medication-reminder-notifications", () => ({
  syncMedicationReminderNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../components/PersonalizationPanel", () => ({
  PersonalizationPanel: () => React.createElement("div", null, "PersonalizationPanel"),
}));

vi.mock("../components/AccountErasurePanel", () => ({
  AccountErasurePanel: () => React.createElement("div", null, "AccountErasurePanel"),
}));

vi.mock("../components/ProviderLogo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) =>
    React.createElement("span", { "data-testid": `provider-logo-${provider}` }),
}));

const mockRouterPush = vi.fn();
const mockRouterSetParams = vi.fn();
let mockSearchParams: { focus?: string; reminderId?: string; tab?: string } = {};
const mockLogout = vi.fn();
const mockCheckoutSession = vi.fn();
const mockPortalSession = vi.fn();
const mockConnectBleHeartRateMonitor = vi.fn().mockResolvedValue(undefined);
const mockDisconnectBleHeartRateMonitor = vi.fn();
const mockBleHeartRateState = {
  bluetoothAvailable: true,
  connectionState: "disconnected" as const,
  device: null,
  liveBpm: null,
};
const checkoutOperationId = "10000000-0000-4000-8000-000000000001";
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
  useRouter: () => ({ push: mockRouterPush, setParams: mockRouterSetParams }),
  useLocalSearchParams: () => mockSearchParams,
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => checkoutOperationId,
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    logout: mockLogout,
    serverUrl: "https://test.example.com",
    sessionToken: mockSessionToken,
  }),
}));

vi.mock("../lib/background-ble-heart-rate-sync", () => ({
  connectBleHeartRateMonitor: (...args: unknown[]) => mockConnectBleHeartRateMonitor(...args),
  disconnectBleHeartRateMonitor: (...args: unknown[]) => mockDisconnectBleHeartRateMonitor(...args),
  getBleHeartRateSyncState: () => mockBleHeartRateState,
  subscribeBleHeartRateSyncState: () => () => undefined,
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
const mockZeppConnectionRevoke = vi.fn();
let mockZeppConnections: Array<{
  connectionType: "zepp-main" | "zepp-workout";
}> = [];
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
const mockSetPasswordMutate = vi.fn();
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
            mutate: mockSetPasswordMutate,
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
    companionToken: {
      list: {
        useQuery: () => ({
          data: mockZeppConnections,
          error: null,
          isLoading: false,
          refetch: vi.fn().mockResolvedValue(undefined),
        }),
      },
      revoke: {
        useMutation: () => ({
          mutate: mockZeppConnectionRevoke,
          error: null,
          isPending: false,
        }),
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
            : input.key === "medicationReminders"
              ? { data: { key: "medicationReminders", value: [] }, error: null, refetch: vi.fn() }
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
  mockSearchParams = {};
  mockProvidersQuery.data = mockProvidersData;
  mockProvidersQuery.error = null;
  mockProvidersQuery.isLoading = false;
  mockSessionToken = "test-token";
  mockBillingStatus = {
    ...defaultBillingStatus,
    access: { ...defaultBillingStatus.access },
  };
  mockZeppPairingMutationOptions = null;
  mockZeppConnections = [];
  mockSetPasswordMutationOptions = null;
  mockUnitSettingQuery.data = { key: "unitSystem", value: "metric" };
  mockUnitSettingQuery.error = null;
  vi.clearAllMocks();
});

describe("SettingsScreen categories", () => {
  it("shows searchable categories with Account selected by default", async () => {
    const { default: SettingsScreen } = await import("../app/settings");
    render(<SettingsScreen />);

    expect(screen.getByRole("textbox", { name: "Search settings" })).toBeTruthy();
    for (const category of [
      "Account",
      "Data Sources",
      "Goals & Models",
      "Privacy/Export",
      "Notifications",
      "Billing",
      "Advanced",
    ]) {
      expect(screen.getByRole("button", { name: category })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.queryByText("2 connected")).toBeNull();
  });

  it("filters categories and opens the matching section from a search term", async () => {
    const { default: SettingsScreen } = await import("../app/settings");
    render(<SettingsScreen />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "medication" },
    });

    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.getByText("Medication Reminders")).toBeTruthy();
  });

  it("switches from Account to Data Sources", async () => {
    const { default: SettingsScreen } = await import("../app/settings");
    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Data Sources" }));

    expect(screen.getByText("2 connected")).toBeTruthy();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    const selectedDataSourceCategory = screen
      .getAllByRole("button", { name: "Data Sources" })
      .find((button) => button.getAttribute("aria-selected") === "true");
    expect(selectedDataSourceCategory).toBeTruthy();
    expect(mockRouterSetParams).toHaveBeenCalledWith({ tab: "data-sources" });
  });

  it("opens the Notifications category for medication reminder deep links", async () => {
    mockSearchParams = {
      focus: "medicationReminders",
      reminderId: "11111111-1111-4111-8111-111111111111",
    };
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Medication Reminders")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Notifications" }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Billing" }));
    expect(screen.getAllByText("Billing").length).toBeGreaterThan(1);
  });

  it("respects a billing category deep link", async () => {
    mockSearchParams = { tab: "billing" };
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getAllByText("Billing").length).toBeGreaterThan(1);
    expect(screen.queryByText("Units")).toBeNull();
    expect(screen.getByRole("button", { name: "Billing" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it.each([
    ["connections", "Data Sources", "2 connected"],
    ["general", "Goals & Models", "Units"],
    ["health", "Goals & Models", "Units"],
    ["account", "Account", "Password"],
  ] as const)("normalizes the legacy %s deep link to %s", async (legacyTab, currentCategory, sectionText) => {
    mockSearchParams = { tab: legacyTab };
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    const selectedCategoryButton = screen
      .getAllByRole("button", { name: currentCategory })
      .find((button) => button.getAttribute("aria-selected") === "true");
    expect(selectedCategoryButton).toBeTruthy();
    expect(screen.getByText(sectionText)).toBeTruthy();
  });
});

describe("SettingsScreen unit system", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "goals-models" };
  });

  it("restores the exact cached unit setting and shows the server error when a write fails", async () => {
    const previousSetting = { key: "unitSystem", value: "metric" };
    mockSettingsGetData.mockReturnValue(previousSetting);
    const { default: SettingsScreen } = await import("../app/settings");
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
    const { default: SettingsScreen } = await import("../app/settings");
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
  beforeEach(() => {
    mockSearchParams = { tab: "data-sources" };
  });

  it("renders Data Sources section with connected count", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getAllByText("Data Sources")).toHaveLength(2);
    expect(screen.getByText("2 connected")).toBeTruthy();
  });

  it("lets the user connect a standard Bluetooth heart-rate monitor", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Connect heart-rate monitor" }));

    await waitFor(() => expect(mockConnectBleHeartRateMonitor).toHaveBeenCalledOnce());
  });

  it("renders provider logos for connected providers only", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

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

    const { default: SettingsScreen } = await import("../app/settings");
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

    const { default: SettingsScreen } = await import("../app/settings");
    render(<SettingsScreen />);

    expect(screen.getByText("2 connected")).toBeTruthy();
    expect(screen.getByText("Could not refresh data sources")).toBeTruthy();
    expect(
      screen.getByText("Analytics data is temporarily unavailable. Please retry in a minute."),
    ).toBeTruthy();
  });

  it("exposes the Data Sources card as a named accessibility action", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    const dataSourcesButton = screen
      .getAllByRole("button", { name: "Data Sources" })
      .find((button) => button.getAttribute("aria-busy") !== null);
    if (!dataSourcesButton) throw new Error("Expected the Data Sources card");
    expect(dataSourcesButton.getAttribute("aria-label")).toBe("Data Sources");
  });

  it("uses layman-readable names for Bluetooth and motion developer tools", async () => {
    mockSearchParams = { tab: "advanced" };
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Bluetooth Low Energy probe" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Inertial measurement unit visualization" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage developer integrations" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/developer-integrations");
  });

  it("navigates to providers screen when tapped", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("2 connected"));

    expect(mockRouterPush).toHaveBeenCalledWith("/providers");
  });

  it("navigates to journal trends from the health tracking section", async () => {
    mockSearchParams = { tab: "goals-models" };
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Journal Trends" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/tracking");
  });
});

describe("SettingsScreen reports", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "goals-models" };
  });

  it("opens the health reports screen", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Health Reports" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/reports");
  });
});

describe("SettingsScreen password", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "account" };
  });

  it("renders set password controls when no password credential exists", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: false },
      isLoading: false,
      error: null,
    });

    const { default: SettingsScreen } = await import("../app/settings");

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

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(await screen.findByPlaceholderText("Current password")).toBeTruthy();
    expect(await screen.findByText("Change Password")).toBeTruthy();
  });

  it("shows shared requirements, native semantics, and independent visibility controls", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    const currentPassword = await screen.findByLabelText("Current password");
    const newPassword = screen.getByLabelText("New password");
    const confirmPassword = screen.getByLabelText("Confirm password");

    expect(currentPassword.getAttribute("autocomplete")).toBe("current-password");
    expect(newPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(newPassword.getAttribute("passwordrules")).toBe("minlength: 8; maxlength: 128;");
    expect(confirmPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByText("Use 8–128 characters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show current password" }));
    expect(currentPassword.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide current password" }));
    expect(currentPassword.getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(newPassword.getAttribute("type")).toBe("text");
    expect(confirmPassword.getAttribute("type")).toBe("password");
  });

  it("blocks an invalid new password before calling the mutation", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: false },
      isLoading: false,
      error: null,
    });
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));

    expect(await screen.findByText("Use at least 8 characters.")).toBeTruthy();
    expect(mockSetPasswordMutate).not.toHaveBeenCalled();
  });

  it("requires the current password before changing an existing credential", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));

    expect(await screen.findByText("Enter your current password.")).toBeTruthy();
    expect(mockSetPasswordMutate).not.toHaveBeenCalled();
  });

  it("confirms before logging out after changing an existing password", async () => {
    mockPasswordCredentialStatusQuery.mockReturnValue({
      data: { hasPassword: true },
      isLoading: false,
      error: null,
    });
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { default: SettingsScreen } = await import("../app/settings");

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
  beforeEach(() => {
    mockSearchParams = { tab: "data-sources" };
  });

  it("claims a short code from settings", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    fireEvent.change(screen.getByPlaceholderText("Short code"), {
      target: { value: "ABCD23" },
    });
    fireEvent.click(screen.getByText("Connect Zepp App"));

    expect(mockZeppPairingClaim).toHaveBeenCalledWith({ code: "ABCD23" });
  });

  it("clears stale pairing messages when the code changes", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

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

  it("shows and disconnects each active Zepp app independently", async () => {
    mockZeppConnections = [{ connectionType: "zepp-main" }, { connectionType: "zepp-workout" }];
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Zepp app: Connected")).toBeTruthy();
    expect(screen.getByText("Workout extension: Connected")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Disconnect Workout extension"));
    expect(mockZeppConnectionRevoke).toHaveBeenCalledWith({
      connectionType: "zepp-workout",
    });
  });
});

describe("SettingsScreen medication doses", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "notifications" };
  });

  it("shows medication dose empty state when no imported dose events exist", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Medication Reminders")).toBeTruthy();
    expect(screen.getByText("Optional daily reminders with imported logging state")).toBeTruthy();
    expect(screen.getByText("No medication reminders yet.")).toBeTruthy();
    expect(screen.getByText("Medication Doses")).toBeTruthy();
    expect(screen.getByText("Review imported medication dose events")).toBeTruthy();
    expect(screen.getByText("No medication dose events yet.")).toBeTruthy();
  });
});

describe("SettingsScreen billing", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "billing" };
  });

  it("renders signup-week limited access notice", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getAllByText("Billing").length).toBeGreaterThan(1);
    expect(screen.getByText(/Access limited to your signup week/)).toBeTruthy();
    expect(screen.getByText("Upgrade to Full Access")).toBeTruthy();
  });

  it("starts checkout when the upgrade button is pressed", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    fireEvent.click(screen.getByText("Upgrade to Full Access"));

    await waitFor(() =>
      expect(mockCheckoutSession).toHaveBeenCalledWith({
        operationId: checkoutOperationId,
      }),
    );
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

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Manage Billing")).toBeTruthy();
    fireEvent.click(screen.getByText("Manage Billing"));

    expect(mockPortalSession).toHaveBeenCalled();
  });
});

describe("SettingsScreen export UI rendering", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "privacy-export" };
  });

  it("renders the Start Export button", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Start Export")).toBeTruthy();
  });

  it("renders account deletion controls in Privacy/Export", async () => {
    mockSessionToken = "   ";
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("Danger Zone")).toBeTruthy();
    expect(screen.getByText("AccountErasurePanel")).toBeTruthy();
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

    const { default: SettingsScreen } = await import("../app/settings");

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
  beforeEach(() => {
    mockSearchParams = { tab: "advanced" };
  });

  it("renders OTA created time in the local timezone format", async () => {
    const updatesModule = await import("expo-updates");
    const otaCreatedAt = new Date("2026-03-31T18:22:00.000Z");
    updatesModule.createdAt = otaCreatedAt;

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    const expectedLocalTimestamp = formatDateTime(otaCreatedAt);
    expect(
      screen.getByText((content) => content.includes(`Created: ${expectedLocalTimestamp}`)),
    ).toBeTruthy();

    updatesModule.createdAt = null;
  });
});

describe("SettingsScreen account erasure", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "privacy-export" };
  });

  it("uses the durable account-erasure flow in the danger zone", async () => {
    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    expect(screen.getByText("AccountErasurePanel")).toBeTruthy();
    expect(screen.queryByText("Delete All User Data")).toBeNull();
  });
});

describe("SettingsScreen export flow", () => {
  beforeEach(() => {
    mockSearchParams = { tab: "privacy-export" };
  });

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

    const { default: SettingsScreen } = await import("../app/settings");

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

    const { default: SettingsScreen } = await import("../app/settings");

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

    const { default: SettingsScreen } = await import("../app/settings");

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
          json: () =>
            Promise.resolve({
              error:
                "Export request was saved, but the queue is temporarily unavailable. It will retry automatically.",
            }),
        }),
    );

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    await screen.findByText("No exports available.");
    fireEvent.click(screen.getByText("Start Export"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Export request was saved, but the queue is temporarily unavailable. It will retry automatically.",
        ),
      ).toBeTruthy();
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

    const { default: SettingsScreen } = await import("../app/settings");

    render(<SettingsScreen />);

    await screen.findByText("Available exports");
    fireEvent.click(screen.getByText("Download dofek-export.zip"));

    await waitFor(() => {
      expect(ExpoFile).toHaveBeenCalled();
      expect(mockDownloadFileAsync).toHaveBeenCalledWith(
        "https://test.example.com/api/export/download/export-789",
        expect.objectContaining({
          uri: "file:///tmp/cache/dofek-exports-v1/export-789-dofek-export.zip",
        }),
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
          idempotent: true,
        }),
      );
      expect(shareAsync).toHaveBeenCalledWith(
        "file:///tmp/cache/dofek-exports-v1/export-789-dofek-export.zip",
        expect.objectContaining({ mimeType: "application/zip" }),
      );
      expect(mockFileDelete).toHaveBeenCalledOnce();
    });
  });
});
