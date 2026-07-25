// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./DataSourcesAuthModals.tsx";

const mockCredentialSignIn = vi.hoisted(() => vi.fn());
const mockGarminSignIn = vi.hoisted(() => vi.fn());
const mockWhoopSignIn = vi.hoisted(() => vi.fn());
const mockWhoopVerifyCode = vi.hoisted(() => vi.fn());
const mockWhoopSaveTokens = vi.hoisted(() => vi.fn());
const mockCredentialUseMutation = vi.hoisted(() => vi.fn());
const mockGarminUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopSignInUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopVerifyUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopSaveUseMutation = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    credentialAuth: { signIn: { useMutation: mockCredentialUseMutation } },
    garminAuth: { signIn: { useMutation: mockGarminUseMutation } },
    whoopAuth: {
      signIn: { useMutation: mockWhoopSignInUseMutation },
      verifyCode: { useMutation: mockWhoopVerifyUseMutation },
      saveTokens: { useMutation: mockWhoopSaveUseMutation },
    },
  },
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

afterEach(cleanup);

describe("Data source authentication telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialUseMutation.mockReturnValue({ mutateAsync: mockCredentialSignIn });
    mockGarminUseMutation.mockReturnValue({ mutateAsync: mockGarminSignIn });
    mockWhoopSignInUseMutation.mockReturnValue({ mutateAsync: mockWhoopSignIn });
    mockWhoopVerifyUseMutation.mockReturnValue({ mutateAsync: mockWhoopVerifyCode });
    mockWhoopSaveUseMutation.mockReturnValue({ mutateAsync: mockWhoopSaveTokens });
  });

  it("reports credential sign-in failures without credentials", async () => {
    const error = new Error("Provider rejected credentials");
    const password = "provider-password-must-not-leak";
    mockCredentialSignIn.mockRejectedValue(error);

    render(
      <CredentialAuthModal
        providerId="eight-sleep"
        providerName="Eight Sleep"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "private@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCredentialUseMutation).toHaveBeenCalledWith({
      meta: locallyReportedErrorMeta,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "credentialAuth.signIn",
      providerId: "eight-sleep",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(password);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("private@example.com");
  });

  it("reports Garmin sign-in failures with only provider context", async () => {
    const error = new Error("Garmin unavailable");
    mockGarminSignIn.mockRejectedValue(error);

    render(<GarminAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "private@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "provider-password-must-not-leak" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockGarminUseMutation).toHaveBeenCalledWith({
      meta: locallyReportedErrorMeta,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "garminAuth.signIn",
      providerId: "garmin",
    });
  });

  it("reports WHOOP verification failures without challenge or code", async () => {
    const error = new Error("Verification code expired");
    const challengeId = "challenge-must-not-leak";
    const code = "123456";
    mockWhoopSignIn.mockResolvedValue({
      status: "verification_required",
      challengeId,
    });
    mockWhoopVerifyCode.mockRejectedValue(error);

    render(<WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "private@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "provider-password-must-not-leak" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(screen.getByLabelText("Verification Code")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Verification Code"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockWhoopVerifyUseMutation).toHaveBeenCalledWith({
      meta: locallyReportedErrorMeta,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "whoopAuth.verifyCode",
      providerId: "whoop",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(challengeId);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(code);
  });

  it("reports WHOOP token-save failures without the token", async () => {
    const error = new Error("Could not save WHOOP authorization");
    const token = "whoop-session-token-must-not-leak";
    mockWhoopSignIn.mockResolvedValue({ status: "success", token });
    mockWhoopSaveTokens.mockRejectedValue(error);

    render(<WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "private@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "provider-password-must-not-leak" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockWhoopSaveUseMutation).toHaveBeenCalledWith({
      meta: locallyReportedErrorMeta,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "whoopAuth.saveTokens",
      providerId: "whoop",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
  });
});
