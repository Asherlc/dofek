// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => ({
  Paths: { cache: "/tmp/cache" },
  File: vi.fn(),
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
  useAuth: () => ({ logout: vi.fn() }),
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
