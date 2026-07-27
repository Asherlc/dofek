import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  credentialSignIn,
  tokenConnect,
  garminSignIn,
  mockCaptureException,
  whoopSaveTokens,
  whoopSignIn,
  whoopVerifyCode,
} = vi.hoisted(() => ({
  credentialSignIn: vi.fn(),
  tokenConnect: vi.fn(),
  garminSignIn: vi.fn(),
  mockCaptureException: vi.fn(),
  whoopSaveTokens: vi.fn(),
  whoopSignIn: vi.fn(),
  whoopVerifyCode: vi.fn(),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    credentialAuth: {
      signIn: {
        useMutation: () => ({ mutateAsync: credentialSignIn }),
      },
    },
    tokenAuth: {
      connect: {
        useMutation: () => ({ mutateAsync: tokenConnect }),
      },
    },
    garminAuth: {
      signIn: {
        useMutation: () => ({ mutateAsync: garminSignIn }),
      },
    },
    whoopAuth: {
      signIn: {
        useMutation: () => ({ mutateAsync: whoopSignIn }),
      },
      verifyCode: {
        useMutation: () => ({ mutateAsync: whoopVerifyCode }),
      },
      saveTokens: {
        useMutation: () => ({ mutateAsync: whoopSaveTokens }),
      },
    },
  },
}));

import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "./auth-modals";

describe("provider auth modals", () => {
  beforeEach(() => {
    credentialSignIn.mockReset();
    tokenConnect.mockReset();
    garminSignIn.mockReset();
    mockCaptureException.mockReset();
    whoopSaveTokens.mockReset();
    whoopSignIn.mockReset();
    whoopVerifyCode.mockReset();
  });

  it("reports a credential provider sign-in error while preserving its message", async () => {
    const signInError = new Error("Provider rejected these credentials");
    credentialSignIn.mockRejectedValue(signInError);

    render(
      <CredentialAuthModal
        providerId="wahoo"
        providerName="Wahoo"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "athlete@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Wahoo" }));

    await waitFor(() => {
      expect(screen.getByText("Provider rejected these credentials")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(signInError, {
      source: "provider-credential-auth-sign-in",
      providerId: "wahoo",
    });
  });

  it("connects a personal token and links to the provider instructions", async () => {
    tokenConnect.mockResolvedValue({ success: true });
    const onSuccess = vi.fn();
    render(
      <TokenAuthModal
        providerId="wger"
        providerName="Wger"
        tokenLabel="JWT refresh token"
        instructionsUrl="https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens"
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("JWT refresh token"), {
      target: { value: "personal-refresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Wger" }));

    await waitFor(() => {
      expect(tokenConnect).toHaveBeenCalledWith({
        providerId: "wger",
        token: "personal-refresh",
      });
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  it("reports personal token failures without including the token", async () => {
    const error = new Error("Token rejected");
    const token = "personal-token-must-not-leak";
    tokenConnect.mockRejectedValue(error);
    render(
      <TokenAuthModal
        providerId="ultrahuman"
        providerName="Ultrahuman"
        tokenLabel="Personal API token"
        instructionsUrl="https://vision.ultrahuman.com/developer-docs"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Personal API token"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Ultrahuman" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "provider-token-auth-connect",
      providerId: "ultrahuman",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
  });

  it("keeps the token modal open while a connection is pending", async () => {
    let resolveConnection: ((value: { success: true }) => void) | undefined;
    tokenConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(
      <TokenAuthModal
        providerId="wger"
        providerName="Wger"
        tokenLabel="JWT refresh token"
        instructionsUrl="https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("JWT refresh token"), {
      target: { value: "pending-refresh-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Wger" }));

    const closeButton = screen.getByRole("button", { name: "Close Wger connection" });
    if (!(closeButton instanceof HTMLButtonElement)) {
      throw new Error("Expected the close action to render as a button");
    }
    await waitFor(() => expect(closeButton.disabled).toBe(true));
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => resolveConnection?.({ success: true }));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("reports a Garmin sign-in error while preserving its message", async () => {
    const signInError = new Error("Garmin rejected these credentials");
    garminSignIn.mockRejectedValue(signInError);

    render(<GarminAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "athlete@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Garmin" }));

    await waitFor(() => {
      expect(screen.getByText("Garmin rejected these credentials")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(signInError, {
      source: "provider-garmin-auth-sign-in",
      providerId: "garmin",
    });
  });

  it("reports a WHOOP sign-in error while preserving its message", async () => {
    const signInError = new Error("WHOOP rejected these credentials");
    whoopSignIn.mockRejectedValue(signInError);

    render(<WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "athlete@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to WHOOP" }));

    await waitFor(() => {
      expect(screen.getByText("WHOOP rejected these credentials")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(signInError, {
      source: "provider-whoop-auth-sign-in",
      providerId: "whoop",
    });
  });

  it("reports a WHOOP verification error while preserving its message", async () => {
    const verificationError = new Error("Verification code expired");
    whoopSignIn.mockResolvedValue({
      status: "verification_required",
      challengeId: "challenge-1",
    });
    whoopVerifyCode.mockRejectedValue(verificationError);

    render(<WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "athlete@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to WHOOP" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Verification code")).toBeTruthy();
    });
    fireEvent.change(screen.getByPlaceholderText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify WHOOP code" }));

    await waitFor(() => {
      expect(screen.getByText("Verification code expired")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(verificationError, {
      source: "provider-whoop-auth-verify",
      providerId: "whoop",
    });
  });
});
