// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockFetchConfiguredProviders = vi.hoisted(() => vi.fn());

const captured = vi.hoisted(() => {
  const ref: { component: (() => React.ReactElement) | null } = { component: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => {
    captured.component = options.component;
    return {};
  },
  useSearch: mockUseSearch,
}));

vi.mock("../components/ProviderLogo.tsx", () => ({
  ProviderLogo: () => null,
  providerLabel: (providerId: string) => providerId,
}));

vi.mock("../lib/auth.ts", () => ({
  fetchConfiguredProviders: () => mockFetchConfiguredProviders(),
}));

import "./login.tsx";

function renderLoginPage() {
  if (!captured.component) throw new Error("Login route component not captured");
  const LoginPage = captured.component;
  return render(<LoginPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Login route", () => {
  it("passes a safe onboarding return path to auth provider links", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: "/onboarding" });
    mockFetchConfiguredProviders.mockResolvedValue({ identity: ["google"], data: [] });

    renderLoginPage();

    await waitFor(() => expect(screen.getByText("Sign in with google")).toBeTruthy());
    expect(screen.getByRole("link", { name: /sign in with google/i }).getAttribute("href")).toBe(
      "/auth/login/google?return_to=%2Fonboarding",
    );
  });

  it("keeps the provider guide fallback return path", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: true, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({ identity: ["google"], data: [] });

    renderLoginPage();

    await waitFor(() => expect(screen.getByText("Sign in with google")).toBeTruthy());
    const href = screen.getByRole("link", { name: /sign in with google/i }).getAttribute("href");
    expect(href).not.toBeNull();
    const returnTo = new URLSearchParams(href?.split("?")[1]).get("return_to");
    expect(returnTo).toBe("/dashboard?providerGuide=true");
  });
});
