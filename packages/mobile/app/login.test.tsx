import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    mockIsNativeAppleSignInAvailable.mockResolvedValue(false);
  });

  it("shows title and subtitle", () => {
    mockFetchConfiguredProviders.mockReturnValue(new Promise(() => {}));
    render(<LoginScreen />);
    expect(screen.getByText("Dofek")).toBeTruthy();
    expect(screen.getByText("Sign in to view your health data")).toBeTruthy();
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
    fireEvent.click(screen.getAllByText("Create account")[1]);

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
    expect(signInButton).toHaveProperty("disabled", true);
    expect(signInButton.style.opacity).toBe("0.5");

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "password123" },
    });

    expect(signInButton).toHaveProperty("disabled", false);
    expect(signInButton.style.opacity).toBe("");
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
