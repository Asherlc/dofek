// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBillingStatusQuery = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());
const mockMutation = vi.hoisted(() => ({
  error: null,
  isPending: false,
  isSuccess: false,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/support">{children}</a>,
}));

vi.mock("../components/DataSourcesPanel.tsx", () => ({
  DataSourcesPanel: () => <div>Data sources</div>,
}));
vi.mock("../components/ExportPanel.tsx", () => ({
  ExportPanel: () => <div>Export</div>,
}));
vi.mock("../components/LinkedAccountsPanel.tsx", () => ({
  LinkedAccountsPanel: () => <div>Linked accounts</div>,
}));
vi.mock("../components/MedicationDoseEventsPanel.tsx", () => ({
  MedicationDoseEventsPanel: () => <div>Medication doses</div>,
}));
vi.mock("../components/MedicationRemindersPanel.tsx", () => ({
  MedicationRemindersPanel: () => <div>Medication reminders</div>,
}));
vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../components/PasswordSettingsPanel.tsx", () => ({
  PasswordSettingsPanel: () => <div>Password</div>,
}));
vi.mock("../components/PersonalizationPanel.tsx", () => ({
  PersonalizationPanel: () => <div>Personalization</div>,
}));
vi.mock("../components/PrimaryGoalSelector.tsx", () => ({
  PrimaryGoalSelector: () => <div>Primary goal</div>,
}));
vi.mock("../components/SlackIntegrationPanel.tsx", () => ({
  SlackIntegrationPanel: () => <div>Slack</div>,
}));
vi.mock("../components/UnitSystemToggle.tsx", () => ({
  UnitSystemToggle: () => <div>Units</div>,
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
    billing: {
      createCheckoutSession: { useMutation: () => mockMutation },
      createPortalSession: { useMutation: () => mockMutation },
      status: { useQuery: mockBillingStatusQuery },
    },
    companionPairing: {
      claim: { useMutation: () => mockMutation },
    },
    settings: {
      deleteAllUserData: { useMutation: () => mockMutation },
    },
    useUtils: () => ({ invalidate: mockInvalidate }),
  },
}));
vi.mock("./McpTokensPanel.tsx", () => ({
  McpTokensPanel: () => <div>MCP tokens</div>,
}));

import { SettingsPage } from "./SettingsPage.tsx";

afterEach(cleanup);

describe("SettingsPage", () => {
  beforeEach(() => {
    mockBillingStatusQuery.mockReset();
    mockInvalidate.mockReset();
    mockMutation.mutate.mockReset();
  });

  it("reserves the resolved billing height across subscription states", () => {
    mockBillingStatusQuery.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    const { rerender } = render(<SettingsPage />);
    const loadingContainer = screen.getByRole("region", { name: "Billing" }).firstElementChild;

    expect(loadingContainer).not.toBeNull();
    expect(screen.getByText("Loading subscription status...")).toBeTruthy();
    expect(loadingContainer?.className).toContain("min-h-44");
    expect(loadingContainer?.className).toContain("sm:min-h-32");
    expect(loadingContainer?.className).toContain("lg:min-h-28");

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

    expect(screen.getByText("You currently have full access to your data.")).toBeTruthy();
    const resolvedContainer = screen.getByRole("region", { name: "Billing" }).firstElementChild;
    expect(resolvedContainer?.className).toContain("min-h-44");
    expect(resolvedContainer?.className).toContain("sm:min-h-32");
    expect(resolvedContainer?.className).toContain("lg:min-h-28");
  });
});
