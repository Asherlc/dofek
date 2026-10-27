/** @vitest-environment jsdom */

import type { DeveloperClientSecret, DeveloperClientSummary } from "@dofek/auth/developer-clients";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeveloperIntegrationsPage } from "./DeveloperIntegrationsPage.tsx";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../lib/developer-clients.ts", () => ({
  developerClientsApi: {
    create: mocks.create,
    list: mocks.list,
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
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
  clientSecret: "raw-created-secret",
} satisfies DeveloperClientSecret;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <DeveloperIntegrationsPage />
    </QueryClientProvider>,
  );
  return { invalidate, queryClient };
}

describe("DeveloperIntegrationsPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.create.mockReset();
    mocks.list.mockReset();
  });

  it("shows initial loading", () => {
    mocks.list.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByLabelText("Loading developer integrations.")).toBeTruthy();
  });

  it("surfaces the server list error", async () => {
    mocks.list.mockRejectedValue(new Error("Developer clients are unavailable"));
    renderPage();

    expect(await screen.findByText("Developer clients are unavailable")).toBeTruthy();
  });

  it("shows the empty list state", async () => {
    mocks.list.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("No developer integrations yet.")).toBeTruthy();
    expect(screen.getByText(/POST \/api\/external\/v1\/link\/start/)).toBeTruthy();
    expect(screen.getByText(/"requestedScopes":\["nutrition:write"\]/)).toBeTruthy();
  });

  it("shows active and revoked client summaries with detail links", async () => {
    mocks.list.mockResolvedValue([activeClient, revokedClient]);
    renderPage();

    expect(await screen.findByText("Meal importer")).toBeTruthy();
    expect(screen.getByText("Retired importer")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("revoked")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Meal importer/ })).toHaveProperty(
      "href",
      `${window.location.origin}/developer-integrations/ext_active`,
    );
  });

  it("keeps cached clients visible when a background refresh fails", async () => {
    mocks.list
      .mockResolvedValueOnce([activeClient])
      .mockRejectedValueOnce(new Error("Developer client refresh failed"));
    const { queryClient } = renderPage();
    expect(await screen.findByText("Meal importer")).toBeTruthy();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-clients"] });
    });

    expect(screen.getByText("Meal importer")).toBeTruthy();
    expect(await screen.findByText("Developer client refresh failed")).toBeTruthy();
  });

  it("invalidates only the list, shows the one-time secret locally, and clears it", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue(createdCredential);
    const { invalidate, queryClient } = renderPage();
    await screen.findByText("No developer integrations yet.");

    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: "Created importer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value: "https://client.example/callback" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    expect(await screen.findByText("raw-created-secret")).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledWith({
      name: "Created importer",
      redirectUris: ["https://client.example/callback"],
      scopes: ["nutrition:write"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(JSON.stringify(queryClient.getQueryData(["developer-clients"]))).not.toContain(
      "raw-created-secret",
    );
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain("raw-created-secret");

    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    await waitFor(() => expect(screen.queryByText("raw-created-secret")).toBeNull());
    expect(JSON.stringify(queryClient.getQueryData(["developer-clients"]))).not.toContain(
      "raw-created-secret",
    );
  });
});
