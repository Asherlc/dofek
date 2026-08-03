// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockConfirmPasswordReset = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => {
  const ref: {
    component: (() => React.ReactElement) | null;
    validateSearch: ((search: Record<string, unknown>) => { token?: string }) | null;
  } = { component: null, validateSearch: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component: () => React.ReactElement;
      validateSearch: (search: Record<string, unknown>) => { token?: string };
    }) => {
      captured.component = options.component;
      captured.validateSearch = options.validateSearch;
      return {};
    },
  Link: ({ children }: { children: React.ReactNode }) => <a href="/login">{children}</a>,
  useSearch: mockUseSearch,
}));

vi.mock("../lib/auth.ts", () => ({
  confirmPasswordReset: mockConfirmPasswordReset,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

import "./reset-password.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Reset password route", () => {
  it("keeps a missing token absent and shows an invalid-link state", () => {
    if (!captured.validateSearch) throw new Error("Reset password search validator not captured");
    expect(captured.validateSearch({})).toEqual({});
    expect(captured.validateSearch({ token: "" })).toEqual({});
    expect(captured.validateSearch({ token: "reset-token" })).toEqual({ token: "reset-token" });

    mockUseSearch.mockReturnValue({});
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This password reset link is missing or invalid.",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
    expect(screen.getByRole("link", { name: "Return to sign in" })).toBeTruthy();
    expect(mockConfirmPasswordReset).not.toHaveBeenCalled();
  });

  it("reports confirmation failures without the reset token or password", async () => {
    const error = new Error("Reset link has expired");
    const token = "reset-token-must-not-leak";
    const password = "new-password-must-not-leak";
    mockUseSearch.mockReturnValue({ token });
    mockConfirmPasswordReset.mockRejectedValue(error);
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    await waitFor(() => expect(screen.getByText(error.message)).toBeTruthy());
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "auth.password-reset-confirm",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(password);
  });

  it("shows requirements, reveal controls, password-manager semantics, and Caps Lock status", () => {
    mockUseSearch.mockReturnValue({ token: "reset-token" });
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);

    const newPassword = screen.getByLabelText("New password");
    const confirmPassword = screen.getByLabelText("Confirm password");

    expect(newPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(newPassword.getAttribute("minlength")).toBe("8");
    expect(newPassword.getAttribute("maxlength")).toBe("128");
    expect(confirmPassword.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByText("Use 8–128 characters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(newPassword.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }));
    expect(newPassword.getAttribute("type")).toBe("password");

    const capsLockEvent = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(capsLockEvent, "getModifierState", {
      value: (modifier: string) => modifier === "CapsLock",
    });
    fireEvent(confirmPassword, capsLockEvent);
    expect(screen.getByRole("status")).toHaveTextContent("Caps Lock is on.");
  });

  it("blocks an invalid new password before confirming the reset", async () => {
    mockUseSearch.mockReturnValue({ token: "reset-token" });
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Use at least 8 characters.")).toBeTruthy();
    expect(mockConfirmPasswordReset).not.toHaveBeenCalled();
  });

  it("uses a distinct disabled treatment while confirming the reset", async () => {
    let resolveReset: (() => void) | undefined;
    mockUseSearch.mockReturnValue({ token: "reset-token" });
    mockConfirmPasswordReset.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReset = resolve;
      }),
    );
    if (!captured.component) throw new Error("Reset password route component not captured");
    const ResetPasswordPage = captured.component;

    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    const resetButton = await screen.findByRole("button", { name: "Resetting..." });
    expect(resetButton).toHaveClass("bg-surface-hover", "text-muted", "cursor-not-allowed");
    expect(resetButton).not.toHaveClass("bg-emerald-600", "text-white", "disabled:opacity-50");

    await act(async () => resolveReset?.());
  });
});
