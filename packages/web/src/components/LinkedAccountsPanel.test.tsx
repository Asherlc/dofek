/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedAccountsPanel } from "./LinkedAccountsPanel.tsx";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  fetchConfiguredProviders: vi.fn(),
  linkedAccountsQuery: vi.fn(),
  unlinkMutation: vi.fn(),
}));

vi.mock("../lib/auth.ts", () => ({
  fetchConfiguredProviders: mocks.fetchConfiguredProviders,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    auth: {
      linkedAccounts: {
        useQuery: mocks.linkedAccountsQuery,
      },
      unlinkAccount: {
        useMutation: mocks.unlinkMutation,
      },
    },
  },
}));

vi.mock("./ProviderLogo.tsx", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => <span>{provider} logo</span>,
  providerLabel: (provider: string) =>
    ({
      apple: "Apple",
      google: "Google",
    })[provider] ?? provider,
}));

const linkedGoogleAccount = {
  id: "00000000-0000-0000-0000-000000000001",
  authProvider: "google",
  email: "linked@example.com",
  canUnlink: false,
  unlinkReason: "Cannot unlink your only login method",
};

async function renderPanel() {
  await act(async () => {
    render(<LinkedAccountsPanel />);
  });
}

describe("LinkedAccountsPanel", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.fetchConfiguredProviders.mockReset();
    mocks.fetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mocks.linkedAccountsQuery.mockReset();
    mocks.linkedAccountsQuery.mockReturnValue({
      data: [linkedGoogleAccount],
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    mocks.unlinkMutation.mockReset();
    mocks.unlinkMutation.mockReturnValue({
      error: null,
      isPending: false,
      mutate: vi.fn(),
    });
  });

  it("renders the linked-account server error instead of an empty state", async () => {
    mocks.linkedAccountsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Unable to read linked identities"),
      isLoading: false,
      refetch: vi.fn(),
    });

    await renderPanel();

    expect(screen.getByText("Unable to read linked identities")).toBeDefined();
    expect(screen.queryByText("No linked accounts")).toBeNull();
  });

  it("retains cached linked accounts during a background failure", async () => {
    mocks.linkedAccountsQuery.mockReturnValue({
      data: [linkedGoogleAccount],
      error: new Error("Linked identities refresh failed"),
      isLoading: false,
      refetch: vi.fn(),
    });

    await renderPanel();

    expect(screen.getByText("linked@example.com")).toBeDefined();
    expect(screen.getByText("Linked identities refresh failed")).toBeDefined();
  });

  it("renders configured-provider failures with a retry action without hiding accounts", async () => {
    const providerError = new Error("Failed to fetch providers: 500 Internal Server Error");
    mocks.fetchConfiguredProviders.mockRejectedValue(providerError);

    await renderPanel();

    expect(await screen.findByText(providerError.message)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry loading login methods" })).toBeDefined();
    expect(screen.getByText("linked@example.com")).toBeDefined();
    expect(mocks.captureException).toHaveBeenCalledWith(providerError, {
      context: "fetch-configured-providers",
    });
  });

  it("shows newly available login methods after a successful retry", async () => {
    mocks.fetchConfiguredProviders
      .mockRejectedValueOnce(new Error("Provider lookup failed"))
      .mockResolvedValueOnce({ identity: ["google", "apple"], data: [] });

    await renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Retry loading login methods" }));

    expect(await screen.findByRole("link", { name: "Apple" })).toHaveAttribute(
      "href",
      "/auth/link/apple",
    );
    expect(screen.queryByText("Provider lookup failed")).toBeNull();
  });
});
