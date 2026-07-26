// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockFetchConfiguredProviders = vi.hoisted(() => vi.fn());
const mockLoginWithPassword = vi.hoisted(() => vi.fn());
const mockRegisterWithPassword = vi.hoisted(() => vi.fn());
const mockRequestPasswordReset = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

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
  loginWithPassword: mockLoginWithPassword,
  registerWithPassword: mockRegisterWithPassword,
  requestPasswordReset: mockRequestPasswordReset,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
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

  it("renders email/password form when password auth is enabled", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
      password: true,
    });

    renderLoginPage();

    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with email" })).toBeTruthy();
  });

  it("enables email sign-in only after required credentials are entered", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    const signInButton = await screen.findByRole("button", {
      name: "Sign in with email",
    });
    expect(signInButton).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });

    expect(signInButton).toHaveProperty("disabled", false);
  });

  it("shows forgot password in email sign-in mode", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy(),
    );
  });

  it("reports provider configuration failures without user input", async () => {
    const error = new Error("Provider configuration unavailable");
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockRejectedValue(error);

    renderLoginPage();

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.providers",
    });
  });

  it("reports password sign-in failures without credentials", async () => {
    const error = new Error("Invalid email or password");
    const password = "sign-in-password-secret";
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({ identity: [], data: [], password: true });
    mockLoginWithPassword.mockRejectedValue(error);

    renderLoginPage();

    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.login",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(password);
  });

  it("reports registration failures without credentials", async () => {
    const error = new Error("Account could not be created");
    const password = "registration-password-secret";
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({ identity: [], data: [], password: true });
    mockRegisterWithPassword.mockRejectedValue(error);

    renderLoginPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    const submitButton = screen
      .getAllByRole("button", { name: "Create account" })
      .find((button) => button.getAttribute("type") === "submit");
    if (!submitButton) throw new Error("Registration submit button not found");
    fireEvent.click(submitButton);

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.register",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(password);
  });

  it("reports password-reset request failures without the email", async () => {
    const error = new Error("Password reset service unavailable");
    const email = "private@example.com";
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({ identity: [], data: [], password: true });
    mockRequestPasswordReset.mockRejectedValue(error);

    renderLoginPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.password-reset-request",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(email);
  });
});
