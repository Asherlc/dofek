import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth module before importing LoginScreen
const mockOnLoginSuccess = vi.fn();
const mockFetchConfiguredProviders = vi.fn();
const mockStartOAuthLogin = vi.fn();
const mockStartNativeAppleSignIn = vi.fn();
const mockIsNativeAppleSignInAvailable = vi.fn(() => false);

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
}));

vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationButton: "AppleAuthenticationButton",
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { WHITE: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

vi.mock("../components/ProviderLogo", () => ({
  ProviderLogo: () => null,
}));

const { default: LoginScreen } = await import("./login");

describe("LoginScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockFetchConfiguredProviders.mockRejectedValue(new Error("Network error"));
    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
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
    mockStartOAuthLogin.mockResolvedValue("test-token-123");

    render(<LoginScreen />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with Google")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Sign in with Google"));

    await waitFor(() => {
      expect(mockStartOAuthLogin).toHaveBeenCalledWith("https://test.example.com", "google", false);
    });
    expect(mockOnLoginSuccess).toHaveBeenCalledWith("test-token-123");
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
});
