// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
let mockSearch: {
  tab?: "general" | "health" | "connections" | "account";
  zeppPair?: string;
} = {};

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
    <section>
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
    useUtils: () => ({ invalidate: vi.fn() }),
    settings: {
      deleteAllUserData: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          isSuccess: false,
          error: null,
        }),
      },
    },
    billing: {
      status: { useQuery: () => ({ data: undefined, isLoading: false, error: null }) },
      createCheckoutSession: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
      createPortalSession: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
    },
    companionPairing: {
      claim: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          isSuccess: false,
          error: null,
        }),
      },
    },
  },
}));

beforeEach(() => {
  mockSearch = {};
  vi.clearAllMocks();
});

describe("SettingsPage tabs", () => {
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
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("Integrations")).toBeTruthy();
    expect(screen.queryByText("Billing")).toBeNull();
  });

  it("writes tab changes and Zepp deep links to route search state", async () => {
    mockSearch = { zeppPair: "ABC234" };
    const { SettingsPage } = await import("./SettingsPage.tsx");

    render(<SettingsPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        search: { tab: "connections" },
        replace: true,
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    expect(mockNavigate).toHaveBeenCalledWith({ search: { tab: "account" } });
  });
});
