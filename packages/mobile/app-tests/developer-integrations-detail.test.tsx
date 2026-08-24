/** @vitest-environment jsdom */

import type { DeveloperClientDetail, DeveloperClientSecret } from "@dofek/auth/developer-clients";
import { formatDateTime } from "@dofek/format/format";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeveloperClientDetailScreen from "../app/developer-integrations/[clientId]";

const state = vi.hoisted<{ clientId: unknown }>(() => ({ clientId: "ext_detail" }));
const mocks = vi.hoisted(() => ({
  createApi: vi.fn(),
  get: vi.fn(),
  revoke: vi.fn(),
  rotate: vi.fn(),
  setStringAsync: vi.fn(),
  update: vi.fn(),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ clientId: state.clientId }),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ serverUrl: "https://dofek.example", sessionToken: "mobile-session" }),
}));

vi.mock("../lib/developer-clients", () => ({
  createMobileDeveloperClientsApi: mocks.createApi,
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

const revokedClient = { ...activeClient, status: "revoked" } satisfies DeveloperClientDetail;

const rotatedCredential = {
  client: { ...activeClient, lastRotatedAt: "2026-08-25T18:00:00.000Z" },
  clientSecret: "raw-mobile-rotated-secret",
} satisfies DeveloperClientSecret;

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <DeveloperClientDetailScreen />
    </QueryClientProvider>,
  );
  return { invalidate, queryClient };
}

function latestAlertButtons() {
  return vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
}

describe("DeveloperClientDetailScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.clientId = "ext_detail";
    vi.mocked(Alert.alert).mockReset();
    mocks.createApi.mockReset();
    mocks.get.mockReset();
    mocks.revoke.mockReset();
    mocks.rotate.mockReset();
    mocks.setStringAsync.mockReset();
    mocks.update.mockReset();
    mocks.setStringAsync.mockResolvedValue(undefined);
    mocks.createApi.mockReturnValue({
      get: mocks.get,
      revoke: mocks.revoke,
      rotate: mocks.rotate,
      update: mocks.update,
    });
  });

  it("rejects a missing or non-string client ID before calling the API", () => {
    state.clientId = ["ext_detail"];
    renderScreen();

    expect(screen.getByText("Developer integration ID is missing.")).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("shows loading and the exact server query error", async () => {
    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    const first = renderScreen();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    cleanup();
    first.queryClient.clear();

    mocks.get.mockRejectedValueOnce(new Error("Detail lookup failed"));
    renderScreen();
    expect(await screen.findByText("Detail lookup failed")).toBeTruthy();
  });

  it("shows all safe active-client fields", async () => {
    mocks.get.mockResolvedValue(activeClient);
    renderScreen();

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
    const { invalidate } = renderScreen();
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
    fireEvent.click(screen.getByRole("button", { name: "Save integration" }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("ext_detail", {
        name: "Updated importer",
        redirectUris: ["https://updated.example/callback", "https://new.example/callback"],
      }),
    );
    expect(await screen.findByText("Updated importer")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["developer-clients", "ext_detail"],
    });
  });

  it("cancels or confirms rotation and keeps the replacement secret out of query data", async () => {
    mocks.get.mockResolvedValue(activeClient);
    mocks.rotate.mockResolvedValue(rotatedCredential);
    const { invalidate, queryClient } = renderScreen();
    await screen.findByText("Meal importer");

    fireEvent.click(screen.getByRole("button", { name: "Rotate client secret" }));
    expect(Alert.alert).toHaveBeenCalledWith(
      "Rotate client secret?",
      expect.stringMatching(/existing secret stops working immediately/i),
      expect.any(Array),
    );
    act(() =>
      latestAlertButtons()
        ?.find((button) => button.text === "Cancel")
        ?.onPress?.(),
    );
    expect(mocks.rotate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rotate client secret" }));
    act(() =>
      latestAlertButtons()
        ?.find((button) => button.text === "Rotate")
        ?.onPress?.(),
    );

    expect(await screen.findByText("raw-mobile-rotated-secret")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["developer-clients"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["developer-clients", "ext_detail"],
    });
    expect(
      JSON.stringify(queryClient.getQueryData(["developer-clients", "ext_detail"])),
    ).not.toContain("raw-mobile-rotated-secret");
    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    expect(screen.queryByText("raw-mobile-rotated-secret")).toBeNull();
  });

  it("cancels or confirms revocation and immediately disables all controls", async () => {
    mocks.get.mockResolvedValueOnce(activeClient).mockResolvedValue(revokedClient);
    mocks.revoke.mockResolvedValue({ revoked: true });
    const { invalidate } = renderScreen();
    await screen.findByText("Meal importer");

    fireEvent.click(screen.getByRole("button", { name: "Revoke developer integration" }));
    expect(Alert.alert).toHaveBeenCalledWith(
      "Revoke developer integration?",
      expect.stringMatching(/all active grants stop working immediately/i),
      expect.any(Array),
    );
    act(() =>
      latestAlertButtons()
        ?.find((button) => button.text === "Cancel")
        ?.onPress?.(),
    );
    expect(mocks.revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke developer integration" }));
    act(() =>
      latestAlertButtons()
        ?.find((button) => button.text === "Revoke")
        ?.onPress?.(),
    );

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

  it("surfaces a mutation error message", async () => {
    mocks.get.mockResolvedValue(activeClient);
    mocks.update.mockRejectedValue(new Error("The redirect URI is already registered"));
    renderScreen();
    await screen.findByText("Meal importer");

    fireEvent.click(screen.getByRole("button", { name: "Save integration" }));

    expect(await screen.findByText("The redirect URI is already registered")).toBeTruthy();
  });

  it("keeps revoked details readable while disabling every mutation control", async () => {
    mocks.get.mockResolvedValue(revokedClient);
    renderScreen();

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
