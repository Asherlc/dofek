// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { CredentialAuthModal, GarminAuthModal, WhoopAuthModal } from "./DataSourcesAuthModals.tsx";

const mockCredentialSignIn = vi.hoisted(() => vi.fn());
const mockTokenConnect = vi.hoisted(() => vi.fn());
const mockGarminSignIn = vi.hoisted(() => vi.fn());
const mockWhoopSignIn = vi.hoisted(() => vi.fn());
const mockWhoopVerifyCode = vi.hoisted(() => vi.fn());
const mockWhoopSaveTokens = vi.hoisted(() => vi.fn());
const mockCredentialUseMutation = vi.hoisted(() => vi.fn());
const mockTokenUseMutation = vi.hoisted(() => vi.fn());
const mockGarminUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopSignInUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopVerifyUseMutation = vi.hoisted(() => vi.fn());
const mockWhoopSaveUseMutation = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    credentialAuth: { signIn: { useMutation: mockCredentialUseMutation } },
    tokenAuth: { connect: { useMutation: mockTokenUseMutation } },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockCredentialUseMutation.mockReturnValue({ mutateAsync: mockCredentialSignIn });
  mockTokenUseMutation.mockReturnValue({ mutateAsync: mockTokenConnect });
  mockGarminUseMutation.mockReturnValue({ mutateAsync: mockGarminSignIn });
  mockWhoopSignInUseMutation.mockReturnValue({ mutateAsync: mockWhoopSignIn });
  mockWhoopVerifyUseMutation.mockReturnValue({ mutateAsync: mockWhoopVerifyCode });
  mockWhoopSaveUseMutation.mockReturnValue({ mutateAsync: mockWhoopSaveTokens });
});

describe("data source auth dialogs", () => {
  it("trims credential usernames before submitting them", async () => {
    render(
      <CredentialAuthModal
        providerId="polar"
        providerName="Polar"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  athlete@example.com  " },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(mockCredentialSignIn).toHaveBeenCalledWith({
        providerId: "polar",
        username: "athlete@example.com",
        password: "secret",
      });
    });
  });

  it.each([
    {
      name: "credential sign-in",
      renderDialog: () => (
        <CredentialAuthModal
          providerId="polar"
          providerName="Polar"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      ),
    },
    {
      name: "Garmin sign-in",
      renderDialog: () => <GarminAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />,
    },
    {
      name: "WHOOP sign-in",
      renderDialog: () => <WhoopAuthModal onClose={vi.fn()} onSuccess={vi.fn()} />,
    },
  ])("uses actionable disabled styling for $name", ({ renderDialog }) => {
    render(renderDialog());
    const signInButton = screen.getByRole("button", { name: "Sign In" });

    expect(signInButton).toBeDisabled();
    expect(signInButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(signInButton).not.toHaveClass("bg-emerald-600", "text-white", "disabled:opacity-50");
    expect(screen.getByText("Enter your email and password to continue.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "athlete@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    });

    expect(signInButton).toBeEnabled();
    expect(signInButton).toHaveClass("bg-emerald-600", "text-white");
    expect(screen.queryByText("Enter your email and password to continue.")).toBeNull();
  });

  it.each([
    {
      name: "Connect Polar",
      renderDialog: (onClose: () => void) => (
        <CredentialAuthModal
          providerId="polar"
          providerName="Polar"
          onClose={onClose}
          onSuccess={() => {}}
        />
      ),
    },
    {
      name: "Connect Garmin",
      renderDialog: (onClose: () => void) => (
        <GarminAuthModal onClose={onClose} onSuccess={() => {}} />
      ),
    },
    {
      name: "Connect WHOOP",
      renderDialog: (onClose: () => void) => (
        <WhoopAuthModal onClose={onClose} onSuccess={() => {}} />
      ),
    },
  ])("makes $name accessible and keyboard-dismissible", async ({ name, renderDialog }) => {
    const onClose = vi.fn();
    render(renderDialog(onClose));

    const email = screen.getByLabelText("Email");
    expect(screen.getByRole("dialog", { name })).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(email).toHaveFocus());

    fireEvent.keyDown(email, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Data source authentication telemetry", () => {
  it("connects a personal token without exposing it to telemetry", async () => {
    mockTokenConnect.mockResolvedValue({ success: true });
    const token = "personal-token-must-not-leak";
    const onSuccess = vi.fn();
    const { TokenAuthModal } = await import("./DataSourcesAuthModals.tsx");

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
    fireEvent.change(screen.getByLabelText("JWT refresh token"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(mockTokenConnect).toHaveBeenCalledWith({ providerId: "wger", token });
      expect(onSuccess).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole("link", { name: "Create a JWT refresh token" })).toHaveAttribute(
      "href",
      "https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
    );
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
  });

  it("uses actionable disabled styling until a personal token is entered", async () => {
    const { TokenAuthModal } = await import("./DataSourcesAuthModals.tsx");

    render(
      <TokenAuthModal
        providerId="wger"
        providerName="Wger"
        tokenLabel="JWT refresh token"
        instructionsUrl="https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const connectButton = screen.getByRole("button", { name: "Connect" });

    expect(connectButton).toBeDisabled();
    expect(connectButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(connectButton).not.toHaveClass("bg-emerald-600", "text-white", "disabled:opacity-50");
    expect(screen.getByText("Enter your token to continue.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("JWT refresh token"), {
      target: { value: "personal-refresh" },
    });

    expect(connectButton).toBeEnabled();
    expect(connectButton).toHaveClass("bg-emerald-600", "text-white");
    expect(screen.queryByText("Enter your token to continue.")).toBeNull();
  });

  it("reports personal token failures with provider context only", async () => {
    const error = new Error("Token rejected");
    const token = "rejected-token-must-not-leak";
    mockTokenConnect.mockRejectedValue(error);
    const { TokenAuthModal } = await import("./DataSourcesAuthModals.tsx");

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
    fireEvent.change(screen.getByLabelText("Personal API token"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(error.message));
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "tokenAuth.connect",
      providerId: "ultrahuman",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
  });

  it("keeps the token modal open while a connection is pending", async () => {
    let resolveConnection: ((value: { success: true }) => void) | undefined;
    mockTokenConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const { TokenAuthModal } = await import("./DataSourcesAuthModals.tsx");

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
    fireEvent.change(screen.getByLabelText("JWT refresh token"), {
      target: { value: "pending-refresh-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => resolveConnection?.({ success: true }));
    expect(onSuccess).toHaveBeenCalledOnce();
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
