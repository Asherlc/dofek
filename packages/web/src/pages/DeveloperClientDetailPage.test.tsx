/** @vitest-environment jsdom */

import type { DeveloperClientDetail, DeveloperClientSecret } from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeveloperClientDetailPage } from "./DeveloperClientDetailPage.tsx";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  revoke: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ clientId: "ext_detail" }),
}));

vi.mock("../lib/developer-clients.ts", () => ({
  developerClientsApi: mocks,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({
    children,
    subtitle,
    title,
  }: {
    children: ReactNode;
    subtitle?: string;
    title?: string;
  }) => (
    <main>
      {title ? <h1>{title}</h1> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </main>
  ),
}));

const activeClient = {
  clientId: "ext_detail",
  name: "Meal importer",
  redirectUris: ["https://client.example/callback", "https://client.example/alternate-callback"],
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-20T18:00:00.000Z",
  lastRotatedAt: "2026-08-24T18:00:00.000Z",
} satisfies DeveloperClientDetail;

const revokedClient = {
  ...activeClient,
  status: "revoked",
} satisfies DeveloperClientDetail;

const rotatedCredential = {
  client: {
    ...activeClient,
    lastRotatedAt: "2026-08-25T18:00:00.000Z",
  },
  clientSecret: "raw-rotated-secret",
} satisfies DeveloperClientSecret;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <DeveloperClientDetailPage />
    </QueryClientProvider>,
  );
  return { invalidate, queryClient };
}

describe("DeveloperClientDetailPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.revoke.mockReset();
    mocks.rotate.mockReset();
    mocks.update.mockReset();
  });

  it("shows loading and a server query error", async () => {
    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    const first = renderPage();
    expect(screen.getByLabelText("Loading developer integration.")).toBeTruthy();
    cleanup();
    first.queryClient.clear();

    mocks.get.mockRejectedValueOnce(new Error("Detail lookup failed"));
    renderPage();
    expect(await screen.findByText("Detail lookup failed")).toBeTruthy();
  });

  it("shows all safe active-client fields without private authorization records", async () => {
    mocks.get.mockResolvedValue(activeClient);
    renderPage();

    expect(await screen.findByText("Meal importer")).toBeTruthy();
    expect(screen.getByText("ext_detail")).toBeTruthy();
    expect(screen.getByText("https://client.example/callback")).toBeTruthy();
    expect(screen.getByText("https://client.example/alternate-callback")).toBeTruthy();
    expect(screen.getAllByText("nutrition:write").length).toBeGreaterThan(0);
    expect(screen.getByText(formatDateTime(activeClient.createdAt))).toBeTruthy();
    expect(screen.getByText(formatDateTime(activeClient.lastRotatedAt))).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.queryByText(/grant/i)).toBeNull();
    expect(screen.queryByText(/external subject/i)).toBeNull();
    expect(screen.queryByText(/audit/i)).toBeNull();
  });

  it("submits the full canonical edit and replaces displayed data", async () => {
    const updated = {
      ...activeClient,
      name: "Updated importer",
      redirectUris: ["https://updated.example/callback", "https://new.example/callback"],
    } satisfies DeveloperClientDetail;
    mocks.get.mockResolvedValueOnce(activeClient).mockResolvedValue(updated);
    mocks.update.mockResolvedValue(updated);
    renderPage();
    await screen.findByText("Meal importer");

    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: " Updated importer " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value: "https://updated.example/callback" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 2" }), {
      target: { value: "https://new.example/callback" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("ext_detail", {
        name: "Updated importer",
        redirectUris: ["https://updated.example/callback", "https://new.example/callback"],
      }),
    );
    expect(await screen.findByText("Updated importer")).toBeTruthy();
    expect(screen.getAllByText("https://updated.example/callback").length).toBeGreaterThan(0);
  });

  it("requires rotate confirmation, keeps the raw secret local, and invalidates detail and list", async () => {
    mocks.get.mockResolvedValue(activeClient);
    mocks.rotate.mockResolvedValue(rotatedCredential);
    const { invalidate, queryClient } = renderPage();
    await screen.findByText("Meal importer");

    fireEvent.click(screen.getByRole("button", { name: "Rotate client secret" }));
    expect(screen.getByText(/existing secret stops working immediately/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel rotation" }));
    expect(mocks.rotate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rotate client secret" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rotation" }));

    expect(await screen.findByText("raw-rotated-secret")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["developer-clients", "ext_detail"],
    });
    expect(
      JSON.stringify(queryClient.getQueryData(["developer-clients", "ext_detail"])),
    ).not.toContain("raw-rotated-secret");
    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    expect(screen.queryByText("raw-rotated-secret")).toBeNull();
  });

  it("requires revoke confirmation, invalidates detail and list, and disables revoked controls", async () => {
    mocks.get.mockResolvedValueOnce(activeClient).mockResolvedValue(revokedClient);
    mocks.revoke.mockResolvedValue({ revoked: true });
    const { invalidate } = renderPage();
    await screen.findByText("Meal importer");

    fireEvent.click(screen.getByRole("button", { name: "Revoke developer integration" }));
    expect(screen.getByText(/all active grants stop working immediately/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel revocation" }));
    expect(mocks.revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke developer integration" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));

    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["developer-clients", "ext_detail"],
    });
    expect(screen.getByRole("button", { name: "Save integration" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Rotate client secret" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Revoke developer integration" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("surfaces mutation error.message", async () => {
    mocks.get.mockResolvedValue(activeClient);
    mocks.update.mockRejectedValue(new Error("The redirect URI is already registered"));
    renderPage();
    await screen.findByText("Meal importer");

    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    expect(await screen.findByText("The redirect URI is already registered")).toBeTruthy();
  });

  it("keeps revoked details readable while disabling every mutation control", async () => {
    mocks.get.mockResolvedValue(revokedClient);
    renderPage();

    expect(await screen.findByText("revoked")).toBeTruthy();
    expect(screen.getByText("https://client.example/callback")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save integration" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Rotate client secret" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Revoke developer integration" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
