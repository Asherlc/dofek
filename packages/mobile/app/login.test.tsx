import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Linking, useWindowDimensions } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

// Mock auth module before importing LoginScreen
const mockOnLoginSuccess = vi.fn();
const mockFetchConfiguredProviders = vi.fn();
const mockStartOAuthLogin = vi.fn();
const mockStartNativeAppleSignIn = vi.fn();
const mockIsNativeAppleSignInAvailable = vi.fn(async () => false);
const mockLoginWithPassword = vi.fn();
const mockRegisterWithPassword = vi.fn();
const mockRequestPasswordReset = vi.fn();
const mockRouterReplace = vi.fn();
const mockUseWindowDimensions = vi.mocked(useWindowDimensions);
const mockOpenUrl = vi.spyOn(Linking, "openURL");

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    onLoginSuccess: mockOnLoginSuccess,
  }),
}));

vi.mock("../lib/auth", () => ({
  fetchConfiguredProviders: (...args: unknown[]) => mockFetchConfiguredProviders(...args),
  startOAuthLogin: (...args: unknown[]) => mockStartOAuthLogin(...args),
  startNativeAppleSignIn: (...args: unknown[]) => mockStartNativeAppleSignIn(...args),
  isNativeAppleSignInAvailable: () => mockIsNativeAppleSignInAvailable(),
  loginWithPassword: (...args: unknown[]) => mockLoginWithPassword(...args),
  registerWithPassword: (...args: unknown[]) => mockRegisterWithPassword(...args),
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
}));

vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationButton: ({ onPress }: { onPress?: (() => void) | undefined }) => (
    <button onClick={onPress} type="button">
      AppleAuthenticationButton
    </button>
  ),
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { WHITE: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

vi.mock("../components/ProviderLogo", () => ({
  ProviderLogo: () => null,
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

const { default: LoginScreen } = await import("./login");

describe("LoginScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenUrl.mockResolvedValue();
    mockIsNativeAppleSignInAvailable.mockResolvedValue(false);
    mockUseWindowDimensions.mockReturnValue({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    });
  });

  it("keeps the auth actions reachable in an inset-aware keyboard-safe scroll view", () => {
    mockFetchConfiguredProviders.mockReturnValue(new Promise(() => {}));

    const { container } = render(<LoginScreen />);

    const scrollView = container.querySelector("scrollview");
    expect(scrollView).not.toBeNull();
    expect(scrollView?.getAttribute("data-automatically-adjust-keyboard-insets")).toBe("true");
    expect(scrollView?.getAttribute("contentinsetadjustmentbehavior")).toBe("automatic");
    expect(scrollView?.getAttribute("keyboarddismissmode")).toBe("interactive");
    expect(scrollView?.getAttribute("keyboardshouldpersisttaps")).toBe("handled");
  });

  it("stacks the auth mode actions when the system font size is enlarged", async () => {
    mockUseWindowDimensions.mockReturnValue({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 2,
    });
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    const signInModeButton = await screen.findByRole("button", { name: "Sign in" });
    const createAccountModeButton = screen.getByRole("button", { name: "Create account" });
    expect(signInModeButton.parentElement?.style.flexDirection).toBe("column");
    expect(signInModeButton.style.width).toBe("100%");
    expect(createAccountModeButton.style.width).toBe("100%");
  });

  it("keeps the auth mode actions side by side at the standard font size", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    const signInModeButton = await screen.findByRole("button", { name: "Sign in" });
    expect(signInModeButton.parentElement?.style.flexDirection).toBe("row");
  });

  it("shows task-specific sign-in title and subtitle", () => {
    mockFetchConfiguredProviders.mockReturnValue(new Promise(() => {}));
    render(<LoginScreen />);
    expect(screen.getByText("Sign in to Dofek")).toBeTruthy();
    expect(screen.getByText("View and manage your health data.")).toBeTruthy();
  });

  it("explains the registration task and next step", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    expect(screen.getByText("Create your account")).toBeTruthy();
    expect(
      screen.getByText("Enter your details. Next, you'll connect your health data."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account and continue" })).toBeTruthy();
  });

  it("shows legal context and an existing-account path during registration", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));

    expect(screen.getByRole("link", { name: "Terms of Service" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Sign in to Dofek")).toBeTruthy();
  });

  it("opens registration policies on the configured Dofek instance", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    fireEvent.click(screen.getByRole("link", { name: "Terms of Service" }));

    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith("https://test.example.com/terms"));

    fireEvent.click(screen.getByRole("link", { name: "Privacy Policy" }));

    await waitFor(() =>
      expect(mockOpenUrl).toHaveBeenCalledWith("https://test.example.com/privacy"),
    );
  });

  it("reports a legal-document launch failure and explains it to the user", async () => {
    const openError = new Error("Browser unavailable");
    mockOpenUrl.mockRejectedValueOnce(openError).mockResolvedValueOnce();
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    fireEvent.click(screen.getByRole("link", { name: "Privacy Policy" }));

    await waitFor(() =>
      expect(screen.getByText("Could not open the Privacy Policy. Try again.")).toBeTruthy(),
    );
    expect(mockCaptureException).toHaveBeenCalledWith(openError, {
      source: "login-screen-open-legal-document",
      document: "privacy",
    });

    fireEvent.click(screen.getByRole("link", { name: "Terms of Service" }));

    await waitFor(() =>
      expect(screen.queryByText("Could not open the Privacy Policy. Try again.")).not.toBeTruthy(),
    );
  });

  it("shows task-specific password reset guidance", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));

    expect(screen.getByText("Reset your password")).toBeTruthy();
    expect(screen.getByText("Enter your email to receive a password reset link.")).toBeTruthy();
  });

  it("shows provider buttons after loading", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google", "apple"],
      data: [],
    });
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });
    expect(screen.getByText("Sign in with Apple")).toBeTruthy();
  });

  it("exposes provider sign-in as a named accessibility action", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    render(<LoginScreen />);

    const signInButton = await screen.findByRole("button", {
      name: "Sign in with Google",
    });

    expect(signInButton.getAttribute("aria-label")).toBe("Sign in with Google");
  });

  it("hides generic Apple OAuth button when native Apple Sign In is available and server supports it", async () => {
    mockIsNativeAppleSignInAvailable.mockResolvedValue(true);
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google", "apple"],
      data: [],
      nativeApple: true,
    });
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
  });

  it("falls back to OAuth Apple button when server does not support native Apple Sign In", async () => {
    mockIsNativeAppleSignInAvailable.mockResolvedValue(true);
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google", "apple"],
      data: [],
      nativeApple: false,
    });
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });
    expect(screen.getByText("Sign in with Apple")).toBeTruthy();
  });

  it("shows data provider buttons", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: ["strava", "wahoo"],
    });
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Strava")).toBeTruthy();
    });
    expect(screen.getByText("Sign in with Wahoo")).toBeTruthy();
  });

  it("shows error message on fetch failure", async () => {
    const providerDiscoveryError = new Error("Network error");
    mockFetchConfiguredProviders.mockRejectedValue(providerDiscoveryError);
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(providerDiscoveryError, {
      source: "login-screen-configured-providers",
    });
  });

  it("shows empty state when no providers configured", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
    });
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("No login providers configured on this server.")).toBeTruthy();
    });
  });

  it("triggers OAuth flow on button press", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mockStartOAuthLogin.mockResolvedValue({ session: "test-token-123", isNewUser: false });

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(mockStartOAuthLogin).toHaveBeenCalledWith("https://test.example.com", "google", false);
    });
    expect(mockOnLoginSuccess).toHaveBeenCalledWith("test-token-123");
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("routes new OAuth users to onboarding after login", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mockStartOAuthLogin.mockResolvedValue({ session: "new-token-123", isNewUser: true });

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(mockOnLoginSuccess).toHaveBeenCalledWith("new-token-123");
    });
    expect(mockRouterReplace).toHaveBeenCalledWith("/onboarding");
  });

  it("does not call onLoginSuccess when OAuth returns no token", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mockStartOAuthLogin.mockResolvedValue(null);

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(mockStartOAuthLogin).toHaveBeenCalled();
    });
    expect(mockOnLoginSuccess).not.toHaveBeenCalled();
  });

  it("routes new password registrations to onboarding after login", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });
    mockRegisterWithPassword.mockResolvedValue({ session: "new-password-token", isNewUser: true });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByText("Create account"));
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "New User" },
    });
    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByText("Create account and continue"));

    await waitFor(() => {
      expect(mockRegisterWithPassword).toHaveBeenCalledWith(
        "https://test.example.com",
        "new@example.com",
        "password123",
        "New User",
      );
    });
    expect(mockOnLoginSuccess).toHaveBeenCalledWith("new-password-token");
    expect(mockRouterReplace).toHaveBeenCalledWith("/onboarding");
  });

  it("advertises current and new credentials to password managers", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    const emailInput = await screen.findByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");
    expect(emailInput.getAttribute("autocomplete")).toBe("email");
    expect(passwordInput.getAttribute("autocomplete")).toBe("current-password");
    expect(passwordInput.getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Password").getAttribute("passwordrules")).toBe(
      "minlength: 8; maxlength: 128;",
    );
    expect(screen.getByText("Use 8–128 characters.")).toBeTruthy();
  });

  it("reveals and hides the password with an accessible control", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    const passwordInput = await screen.findByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "password123" } });

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput.getAttribute("type")).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput.getAttribute("type")).toBe("password");
  });

  it("shows actionable registration errors without sending invalid credentials", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

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

  it("visually distinguishes disabled email sign-in from the enabled state", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    const signInButton = await screen.findByRole("button", {
      name: "Sign in with email",
    });
    const disabledBackgroundColor = signInButton.style.backgroundColor;
    const disabledTextColor = signInButton.firstElementChild?.getAttribute("style");
    expect(signInButton).toHaveProperty("disabled", true);
    expect(signInButton.style.opacity).toBe("");
    expect(screen.getByText("Enter your email and password to continue.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "password123" },
    });

    expect(signInButton).toHaveProperty("disabled", false);
    expect(signInButton.style.backgroundColor).not.toBe(disabledBackgroundColor);
    expect(signInButton.firstElementChild?.getAttribute("style")).not.toBe(disabledTextColor);
    expect(screen.queryByText("Enter your email and password to continue.")).toBeNull();
  });

  it("keeps the password reset action visibly disabled until an email is entered", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    const resetButton = screen.getByRole("button", { name: "Send reset link" });
    const disabledBackgroundColor = resetButton.style.backgroundColor;
    const disabledTextColor = resetButton.firstElementChild?.getAttribute("style");

    expect(resetButton).toHaveProperty("disabled", true);
    expect(resetButton.style.opacity).toBe("");
    expect(screen.getByText("Enter your email to continue.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@example.com" },
    });

    expect(resetButton).toHaveProperty("disabled", false);
    expect(resetButton.style.backgroundColor).not.toBe(disabledBackgroundColor);
    expect(resetButton.firstElementChild?.getAttribute("style")).not.toBe(disabledTextColor);
    expect(screen.queryByText("Enter your email to continue.")).toBeNull();
  });

  it("uses neutral disabled registration styling until required details are entered", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: [],
      data: [],
      password: true,
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    const createAccountButton = screen.getByRole("button", {
      name: "Create account and continue",
    });
    const disabledBackgroundColor = createAccountButton.style.backgroundColor;
    const disabledTextColor = createAccountButton.firstElementChild?.getAttribute("style");

    expect(createAccountButton).toHaveProperty("disabled", true);
    expect(createAccountButton.style.opacity).toBe("");

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "password123" },
    });

    expect(createAccountButton).toHaveProperty("disabled", false);
    expect(createAccountButton.style.backgroundColor).not.toBe(disabledBackgroundColor);
    expect(createAccountButton.firstElementChild?.getAttribute("style")).not.toBe(
      disabledTextColor,
    );
  });

  it("shows error when login fails", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mockStartOAuthLogin.mockRejectedValue(new Error("OAuth cancelled"));

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(screen.getByText("OAuth cancelled")).toBeTruthy();
    });
  });

  it("keeps provider buttons visible after login error so user can retry", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["google"],
      data: [],
    });
    mockStartOAuthLogin.mockRejectedValue(new Error("Login failed"));

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(screen.getByText("Login failed")).toBeTruthy();
    });
    // Provider buttons must still be visible so the user can retry
    expect(screen.getByText("Sign in with Google")).toBeTruthy();
  });

  it("keeps native Apple button visible after sign-in error so user can retry", async () => {
    mockIsNativeAppleSignInAvailable.mockResolvedValue(true);
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["apple"],
      data: [],
      nativeApple: true,
    });
    mockStartNativeAppleSignIn.mockRejectedValue(new Error("Apple Sign In failed: 500"));

    render(<LoginScreen />);

    const appleButton = await screen.findByText("AppleAuthenticationButton");
    fireEvent.click(appleButton);

    await waitFor(() => {
      expect(screen.getByText("Apple Sign In failed: 500")).toBeTruthy();
    });
    // Native Apple button must still be visible so the user can retry
    expect(screen.getByText("AppleAuthenticationButton")).toBeTruthy();
  });

  it("does not fall back to OAuth when native Apple Sign In fails", async () => {
    mockIsNativeAppleSignInAvailable.mockResolvedValue(true);
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["apple"],
      data: [],
      nativeApple: true,
    });
    mockStartNativeAppleSignIn.mockRejectedValue(new Error("native apple failed"));
    mockStartOAuthLogin.mockResolvedValue({ session: "fallback-token", isNewUser: false });

    render(<LoginScreen />);

    const appleButton = await screen.findByText("AppleAuthenticationButton");
    fireEvent.click(appleButton);

    await waitFor(() => {
      expect(mockStartNativeAppleSignIn).toHaveBeenCalledWith("https://test.example.com");
    });
    expect(mockStartOAuthLogin).not.toHaveBeenCalled();
    expect(screen.getByText("native apple failed")).toBeTruthy();
  });

  it("handles native Apple Sign In cancellation silently", async () => {
    mockIsNativeAppleSignInAvailable.mockResolvedValue(true);
    mockFetchConfiguredProviders.mockResolvedValue({
      identity: ["apple"],
      data: [],
      nativeApple: true,
    });
    mockStartNativeAppleSignIn.mockResolvedValue(null);

    render(<LoginScreen />);

    const appleButton = await screen.findByText("AppleAuthenticationButton");
    fireEvent.click(appleButton);

    await waitFor(() => {
      expect(mockStartNativeAppleSignIn).toHaveBeenCalled();
    });
    expect(mockStartOAuthLogin).not.toHaveBeenCalled();
    expect(screen.queryByText("User canceled")).toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "login-screen-handle-login" }),
    );
  });

  it("requests a password reset from sign-in mode", async () => {
    mockFetchConfiguredProviders.mockResolvedValue({ identity: [], data: [], password: true });
    mockRequestPasswordReset.mockResolvedValue({
      message: "If that email has a password login, we'll send a reset link.",
    });

    render(<LoginScreen />);

    fireEvent.click(await screen.findByText("Forgot password?"));
    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByText("Send reset link"));

    await waitFor(() =>
      expect(mockRequestPasswordReset).toHaveBeenCalledWith(
        "https://test.example.com",
        "user@example.com",
      ),
    );
  });
});
