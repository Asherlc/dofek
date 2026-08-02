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
    expect(screen.getByRole("heading", { name: "Sign in to Dofek" })).toBeTruthy();
    expect(screen.getByText("View and manage your health data.")).toBeTruthy();
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
    expect(signInButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(screen.getByText("Enter your email and password to continue.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });

    expect(signInButton).toHaveProperty("disabled", false);
    expect(screen.queryByText("Enter your email and password to continue.")).toBeNull();
  });

  it("reveals and hides the current password with an accessible control", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    const passwordInput = await screen.findByLabelText("Password");
    expect(passwordInput.getAttribute("autocomplete")).toBe("current-password");
    expect(passwordInput.getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput.getAttribute("type")).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput.getAttribute("type")).toBe("password");
  });

  it("warns when Caps Lock is active in the password field", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    const passwordInput = await screen.findByLabelText("Password");
    const capsLockEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(capsLockEvent, "getModifierState", {
      value: (modifier: string) => modifier === "CapsLock",
    });
    fireEvent(passwordInput, capsLockEvent);

    expect(screen.getByRole("status")).toHaveTextContent("Caps Lock is on.");

    const capsLockOffEvent = new KeyboardEvent("keyup", { bubbles: true });
    Object.defineProperty(capsLockOffEvent, "getModifierState", {
      value: () => false,
    });
    fireEvent(passwordInput, capsLockOffEvent);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the canonical requirements for a new password", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput.getAttribute("autocomplete")).toBe("new-password");
    expect(passwordInput.getAttribute("minlength")).toBe("8");
    expect(passwordInput.getAttribute("maxlength")).toBe("128");
    expect(screen.getByText("Use 8–128 characters.")).toBeTruthy();
  });

  it("explains the registration task and next step", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(
      screen.getByText("Enter your details. Next, you'll connect your health data."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account and continue" })).toBeTruthy();
  });

  it("shows legal context and an existing-account path during registration", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    expect(screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe(
      "/terms",
    );
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe(
      "/privacy",
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("heading", { name: "Sign in to Dofek" })).toBeTruthy();
  });

  it("shows actionable registration errors without sending invalid credentials", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account and continue" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText("Use at least 8 characters.")).toBeTruthy();
    expect(mockRegisterWithPassword).not.toHaveBeenCalled();
  });

  it("keeps a Dofek home link visible in every auth mode", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    const homeLink = await screen.findByRole("link", { name: "Back to Dofek" });
    expect(homeLink.getAttribute("href")).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("link", { name: "Back to Dofek" }).getAttribute("href")).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("link", { name: "Back to Dofek" }).getAttribute("href")).toBe("/");
  });

  it("uses neutral disabled registration styling until required details are entered", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    const createAccountButton = screen.getByRole("button", {
      name: "Create account and continue",
    });

    expect(createAccountButton).toHaveProperty("disabled", true);
    expect(createAccountButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(createAccountButton).not.toHaveClass("bg-emerald-600", "text-white");

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });

    expect(createAccountButton).toHaveProperty("disabled", false);
    expect(createAccountButton).toHaveClass("bg-emerald-600", "text-white");
    expect(createAccountButton).not.toHaveClass("bg-surface-hover", "text-muted");
  });

  it("shows task-specific password reset guidance", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));

    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    expect(screen.getByText("Enter your email to receive a password reset link.")).toBeTruthy();
  });

  it("keeps the password reset action visibly disabled until an email is entered", async () => {
    mockUseSearch.mockReturnValue({ providerGuide: undefined, returnTo: undefined });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    renderLoginPage();

    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    const resetButton = screen.getByRole("button", { name: "Send reset link" });

    expect(resetButton).toBeDisabled();
    expect(resetButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(screen.getByText("Enter your email to continue.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });

    expect(resetButton).toBeEnabled();
    expect(resetButton).toHaveClass("bg-emerald-600", "text-white");
    expect(screen.queryByText("Enter your email to continue.")).toBeNull();
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
      .getAllByRole("button", { name: "Create account and continue" })
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
