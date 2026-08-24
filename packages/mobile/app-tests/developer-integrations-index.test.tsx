/** @vitest-environment jsdom */

import type { DeveloperClientSecret, DeveloperClientSummary } from "@dofek/auth/developer-clients";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeveloperIntegrationsScreen from "../app/developer-integrations/index";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createApi: vi.fn(),
  list: vi.fn(),
  openExternalUrl: vi.fn(),
  push: vi.fn(),
  setStringAsync: vi.fn(),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://dofek.example",
    sessionToken: "mobile-session",
  }),
}));

vi.mock("../lib/developer-clients", () => ({
  createMobileDeveloperClientsApi: mocks.createApi,
}));

vi.mock("../lib/open-external-url", () => ({
  openExternalUrl: mocks.openExternalUrl,
}));

const activeClient = {
  clientId: "ext_active",
  name: "Meal importer",
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-20T18:00:00.000Z",
  lastRotatedAt: "2026-08-24T18:00:00.000Z",
} satisfies DeveloperClientSummary;

const revokedClient = {
  ...activeClient,
  clientId: "ext_revoked",
  name: "Retired importer",
  status: "revoked",
} satisfies DeveloperClientSummary;

const createdCredential = {
  client: {
    ...activeClient,
    clientId: "ext_created",
    name: "Created importer",
    redirectUris: ["https://client.example/callback"],
  },
  clientSecret: "raw-created-mobile-secret",
} satisfies DeveloperClientSecret;

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <DeveloperIntegrationsScreen />
    </QueryClientProvider>,
  );
  return { invalidate, queryClient };
}

describe("DeveloperIntegrationsScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.create.mockReset();
    mocks.createApi.mockReset();
    mocks.list.mockReset();
    mocks.openExternalUrl.mockReset();
    mocks.push.mockReset();
    mocks.setStringAsync.mockReset();
    mocks.setStringAsync.mockResolvedValue(undefined);
    mocks.createApi.mockReturnValue({ create: mocks.create, list: mocks.list });
  });

  it("shows blocking loading without usable list data", () => {
    mocks.list.mockReturnValue(new Promise(() => {}));
    renderScreen();

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("surfaces the server list error", async () => {
    mocks.list.mockRejectedValue(new Error("Developer clients are unavailable"));
    renderScreen();

    expect(await screen.findByText("Developer clients are unavailable")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    mocks.list.mockResolvedValue([]);
    renderScreen();

    expect(await screen.findByText("No developer integrations yet.")).toBeTruthy();
  });

  it("shows active/revoked clients and navigates to detail and external docs", async () => {
    mocks.list.mockResolvedValue([activeClient, revokedClient]);
    renderScreen();

    expect(await screen.findByText("Meal importer")).toBeTruthy();
    expect(screen.getByText("Retired importer")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("revoked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Meal importer" }));
    expect(mocks.push).toHaveBeenCalledWith("/developer-integrations/ext_active");

    fireEvent.click(screen.getByRole("button", { name: "External API contract" }));
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/Asherlc/dofek/blob/main/docs/external-api.md",
      "developer-integrations",
    );
  });

  it("creates, copies, clears a one-time secret, and invalidates only the list", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue(createdCredential);
    const { invalidate, queryClient } = renderScreen();
    await screen.findByText("No developer integrations yet.");

    expect(mocks.createApi).toHaveBeenCalledWith({
      serverUrl: "https://dofek.example",
      sessionToken: "mobile-session",
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: "Created importer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value: "https://client.example/callback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create integration" }));

    expect(await screen.findByText("raw-created-mobile-secret")).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Created importer",
      redirectUris: ["https://client.example/callback"],
      scopes: ["nutrition:write"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(JSON.stringify(queryClient.getQueryData(["developer-clients"]))).not.toContain(
      "raw-created-mobile-secret",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));
    await waitFor(() =>
      expect(mocks.setStringAsync).toHaveBeenCalledWith("raw-created-mobile-secret"),
    );
    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    expect(screen.queryByText("raw-created-mobile-secret")).toBeNull();
  });
});
