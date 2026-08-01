// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SettingsSearch = {
  tab?: "general" | "health" | "connections" | "account" | "advanced";
  zeppPair?: string;
};

type SettingsNavigation = {
  search: SettingsSearch | ((previous: SettingsSearch) => SettingsSearch);
  replace?: boolean;
};

const mockNavigate = vi.fn<(options: SettingsNavigation) => void>();
const mockBillingStatusQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockMutation = {
  error: null,
  isPending: false,
  isSuccess: false,
  mutate: vi.fn(),
};
let mockSearch: SettingsSearch = {};
let mockZeppConnections: Array<{
  connectionType: "zepp-main" | "zepp-workout";
}> = [];

function applySearch(
  navigation: SettingsNavigation | undefined,
  previous: SettingsSearch,
): SettingsSearch {
  if (!navigation) throw new Error("Expected navigation options");
  return typeof navigation.search === "function" ? navigation.search(previous) : navigation.search;
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/support">{children}</a>,
  useNavigate: () => mockNavigate,
  useSearch: () => mockSearch,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title?: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("../components/DataSourcesPanel.tsx", () => ({
  DataSourcesPanel: () => <div>DataSourcesPanel</div>,
}));
vi.mock("../components/ExportPanel.tsx", () => ({
  ExportPanel: () => <div>ExportPanel</div>,
}));
vi.mock("../components/LinkedAccountsPanel.tsx", () => ({
  LinkedAccountsPanel: () => <div>LinkedAccountsPanel</div>,
}));
vi.mock("../components/MedicationDoseEventsPanel.tsx", () => ({
  MedicationDoseEventsPanel: () => <div>MedicationDoseEventsPanel</div>,
}));
vi.mock("../components/MedicationRemindersPanel.tsx", () => ({
  MedicationRemindersPanel: () => <div>MedicationRemindersPanel</div>,
}));
vi.mock("../components/PasswordSettingsPanel.tsx", () => ({
  PasswordSettingsPanel: () => <div>PasswordSettingsPanel</div>,
}));
vi.mock("../components/PersonalizationPanel.tsx", () => ({
  PersonalizationPanel: () => <div>PersonalizationPanel</div>,
}));
vi.mock("../components/PrimaryGoalSelector.tsx", () => ({
  PrimaryGoalSelector: () => <div>PrimaryGoalSelector</div>,
}));
vi.mock("../components/SlackIntegrationPanel.tsx", () => ({
  SlackIntegrationPanel: () => <div>SlackIntegrationPanel</div>,
}));
vi.mock("../components/UnitSystemToggle.tsx", () => ({
  UnitSystemToggle: () => <div>UnitSystemToggle</div>,
}));
vi.mock("./McpTokensPanel.tsx", () => ({
  McpTokensPanel: () => <div>McpTokensPanel</div>,
}));

vi.mock("../lib/dashboardLayoutContext.ts", () => ({
  SECTION_LABELS: {},
  useDashboardLayout: () => ({
    layout: { hidden: [] },
    resetLayout: vi.fn(),
    toggleHidden: vi.fn(),
  }),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({ invalidate: mockInvalidate }),
    settings: {
      deleteAllUserData: {
        useMutation: () => mockMutation,
      },
    },
    billing: {
      status: { useQuery: mockBillingStatusQuery },
      createCheckoutSession: {
        useMutation: () => mockMutation,
      },
      createPortalSession: {
        useMutation: () => mockMutation,
      },
    },
    companionPairing: {
      claim: {
        useMutation: () => mockMutation,
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
        useMutation: () => mockMutation,
      },
    },
  },
}));

beforeEach(() => {
  mockSearch = {};
  mockZeppConnections = [];
  mockBillingStatusQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  });
  vi.clearAllMocks();
});

describe("SettingsPage tabs", () => {
  it("renders the complete settings tab contract in order", async () => {
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(
      screen.getAllByRole("tab").map((tab) => ({
        id: tab.id,
        label: tab.textContent,
      })),
    ).toEqual([
      { id: "settings-tab-general", label: "General" },
      { id: "settings-tab-health", label: "Health" },
      { id: "settings-tab-connections", label: "Connections" },
      { id: "settings-tab-account", label: "Account" },
      { id: "settings-tab-advanced", label: "Advanced" },
    ]);
  });

  it("shows general settings by default", async () => {
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Units")).toBeTruthy();
    expect(screen.queryByText("Data Sources")).toBeNull();
  });

  it("renders only connection settings for a connections deep link", async () => {
    mockSearch = { tab: "connections" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(screen.getByText("Data Sources")).toBeTruthy();
    expect(screen.getByText("Zepp App Pairing")).toBeTruthy();
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.queryByText("MCP")).toBeNull();
    expect(screen.queryByText("Billing")).toBeNull();
  });

  it("orders normal account settings before billing", async () => {
    mockSearch = { tab: "account" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(
      Array.from(document.querySelectorAll("section"), (section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Linked Accounts",
      "Password",
      "Data Export",
      "Billing",
      "Help & Support",
      "Danger Zone",
    ]);
  });

  it("places MCP settings under Advanced", async () => {
    mockSearch = { tab: "advanced" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "Advanced" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.queryByText("Data Sources")).toBeNull();
  });

  it("shows and disconnects each active Zepp app independently", async () => {
    mockSearch = { tab: "connections" };
    mockZeppConnections = [{ connectionType: "zepp-main" }, { connectionType: "zepp-workout" }];
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(screen.getByText("Zepp app: Connected")).toBeTruthy();
    expect(screen.getByText("Workout extension: Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Zepp app" })).toBeTruthy();
    const workoutDisconnectButton = screen.getByRole("button", {
      name: "Disconnect Workout extension",
    });
    fireEvent.click(workoutDisconnectButton);
    expect(mockMutation.mutate).toHaveBeenCalledWith({
      connectionType: "zepp-workout",
    });
  });

  it("writes Zepp deep links to route search state without retaining the pairing code", async () => {
    mockSearch = { zeppPair: "ABC234" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Data Sources")).toBeTruthy();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const pairingNavigation = mockNavigate.mock.calls[0]?.[0];
    expect(pairingNavigation?.replace).toBe(true);
    expect(applySearch(pairingNavigation, { zeppPair: "ABC234" })).toEqual({
      tab: "connections",
      zeppPair: undefined,
    });
  });

  it("preserves other search state when changing tabs", async () => {
    mockSearch = { tab: "connections" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    const tabNavigation = mockNavigate.mock.calls[0]?.[0];
    expect(applySearch(tabNavigation, { tab: "connections", zeppPair: "ABC234" })).toEqual({
      tab: "account",
      zeppPair: "ABC234",
    });
  });

  it("associates every tab with the rendered tab panel", async () => {
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    const panel = screen.getByRole("tabpanel");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    }
  });

  it("reserves the resolved billing height across subscription states", async () => {
    mockSearch = { tab: "account" };
    mockBillingStatusQuery.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });
    const { SettingsPage } = await import("./SettingsPage.tsx");

    const { rerender } = render(<SettingsPage />);
    const loadingContainer = screen.getByText("Loading subscription status...");

    expect(loadingContainer.className).toContain("min-h-44");
    expect(loadingContainer.className).toContain("sm:min-h-32");
    expect(loadingContainer.className).toContain("lg:min-h-28");

    mockBillingStatusQuery.mockReturnValue({
      data: {
        access: { kind: "full", reason: "paid_grant" },
        canManageBilling: false,
        hasFullAccess: true,
      },
      error: null,
      isLoading: false,
    });
    rerender(<SettingsPage />);

    const resolvedContainer = screen.getByText(
      "You currently have full access to your data.",
    ).parentElement;
    expect(resolvedContainer?.className).toContain("min-h-44");
    expect(resolvedContainer?.className).toContain("sm:min-h-32");
    expect(resolvedContainer?.className).toContain("lg:min-h-28");
  });
});
