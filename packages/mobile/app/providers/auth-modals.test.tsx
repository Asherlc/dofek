import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { credentialSignIn, mockCaptureException } = vi.hoisted(() => ({
  credentialSignIn: vi.fn(),
  mockCaptureException: vi.fn(),
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
  },
}));

import { CredentialAuthModal } from "./auth-modals";

describe("CredentialAuthModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the original sign-in error while preserving the actionable message", async () => {
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
});
