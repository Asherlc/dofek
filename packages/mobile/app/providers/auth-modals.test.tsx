import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  credentialSignIn,
  garminSignIn,
  mockCaptureException,
  whoopSaveTokens,
  whoopSignIn,
  whoopVerifyCode,
} = vi.hoisted(() => ({
  credentialSignIn: vi.fn(),
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

import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./auth-modals";

describe("provider auth modals", () => {
  beforeEach(() => {
    credentialSignIn.mockReset();
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
